-- ============================================================
-- 136: convert_samples_bulk 리팩터 — transactions/영수증 단일 박제
--
-- 사장 검토 (2026-05-06):
--   현재 (131): order INSERT(is_processed=FALSE) + items 다건 INSERT.
--   trg_order_items_revenue 가 매 INSERT 시 발동 → refresh_order_revenue.
--   첫 INSERT 에서 첫 처리 분기 발동(transactions 1건+영수증) +
--   2~N INSERT 에서 v_increment 분기 발동 (transactions N-1건 추가).
--   → transactions 가 N 행 분할 박제. SUM 은 정합이지만 미관/추적 깔끔치 않음.
--
-- 변경:
--   124 process_pending_ship 패턴 차용 — 처음부터 박제값 모두 채워 INSERT,
--   trg refresh 발동해도 no-op 되게 만들고, RPC 가 직접 단일 박제.
--
-- 새 흐름:
--   1) 원 샘플 라인 sample_status='converted' 마킹
--   2) v_balance_before fetch (영수증 박제용)
--   3) orders INSERT — is_processed=TRUE, revenue=v_total, sales_qty=v_qty,
--      confirmed_amount=v_total, order_qty=v_qty 처음부터 박제
--   4) order_items 다건 INSERT (trg refresh 발동해도:
--      v_prev_processed=TRUE + v_revenue 동일 → v_increment=0 → no-op)
--   5) transactions(shipment) — 단일 행 INSERT (RPC 가 직접)
--   6) customers.outstanding_balance += v_total (manual + 132 sync 정합)
--   7) 매입금 자동 충당 분기 (이전 -외상 있으면)
--   8) issue_receipt_snapshot — 단일 호출
--
-- 132 sync trigger (DEFERRED CONSTRAINT TRIGGER):
--   COMMIT 시점에 SUM(transactions) 으로 outstanding 재계산.
--   manual UPDATE 와 동일 값 → 덮어써도 결과 동일. 정합 ✓
--
-- 사장 정합성 보존:
--   - 결제수단별 영수증 박제 (109): payment_method 그대로 사용
--   - 매입금 자동 충당 분기: 그대로
--   - 074-077 매출 박제: transactions(shipment) 가 정확히 1건 → 통계 동일
--   - 105 sales_qty/revenue: orders 에 처음부터 박제, refresh no-op → 변동 X
-- ============================================================

CREATE OR REPLACE FUNCTION convert_samples_bulk(
  p_order_item_ids JSONB,
  p_tenant_id      UUID
) RETURNS JSON LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_ids              UUID[];
  v_first            RECORD;
  v_item             RECORD;
  v_total            NUMERIC := 0;
  v_qty              INT     := 0;
  v_new_order_id     UUID;
  v_new_order_number TEXT;
  v_count            INT     := 0;
  v_id               UUID;
  v_balance_before   NUMERIC := 0;
  v_credit_used      NUMERIC := 0;
BEGIN
  IF p_order_item_ids IS NULL OR jsonb_array_length(p_order_item_ids) = 0 THEN
    RETURN json_build_object('success', false, 'error', '항목이 비어있습니다.');
  END IF;

  SELECT array_agg(value::TEXT::UUID) INTO v_ids
  FROM jsonb_array_elements_text(p_order_item_ids) AS value;

  SELECT
    oi.id, oi.is_sample, oi.sample_status,
    o.customer_id, o.customer_name, o.payment_method, o.order_number, o.order_type
  INTO v_first
  FROM order_items oi
  JOIN orders o ON o.id = oi.order_id
  WHERE oi.id = v_ids[1] AND o.tenant_id = p_tenant_id;

  IF NOT FOUND THEN
    RETURN json_build_object('success', false, 'error', '첫 항목을 찾을 수 없습니다.');
  END IF;

  -- 검증 + 합계 (수량/금액 동시)
  FOR v_item IN
    SELECT oi.id, oi.is_sample, oi.sample_status, oi.quantity, oi.unit_price,
           o.customer_id
    FROM order_items oi
    JOIN orders o ON o.id = oi.order_id
    WHERE oi.id = ANY(v_ids) AND o.tenant_id = p_tenant_id
  LOOP
    IF NOT v_item.is_sample THEN
      RETURN json_build_object('success', false, 'error', '샘플이 아닌 항목 포함');
    END IF;
    IF v_item.sample_status <> 'pending' THEN
      RETURN json_build_object('success', false, 'error', '이미 처리된 샘플 포함');
    END IF;
    IF v_item.customer_id <> v_first.customer_id THEN
      RETURN json_build_object('success', false, 'error', '서로 다른 거래처 항목 혼합');
    END IF;
    v_total := v_total + (v_item.quantity * v_item.unit_price);
    v_qty   := v_qty + v_item.quantity;
    v_count := v_count + 1;
  END LOOP;

  IF v_count <> array_length(v_ids, 1) THEN
    RETURN json_build_object('success', false, 'error', '일부 항목을 찾을 수 없습니다.');
  END IF;

  -- 1) 원본 샘플 라인 일괄 converted 마킹 (이력 보존)
  UPDATE order_items
  SET sample_status = 'converted',
      updated_at    = NOW()
  WHERE id = ANY(v_ids);

  -- 2) 거래처 현 외상잔액 (영수증 박제용 v_prev_balance)
  SELECT COALESCE(outstanding_balance, 0) INTO v_balance_before
  FROM customers WHERE id = v_first.customer_id AND tenant_id = p_tenant_id;

  -- 3) 신규 주문 INSERT — 처음부터 is_processed=TRUE + 매출 박제 (refresh no-op 화)
  v_new_order_number := v_first.order_number || '-S'
    || substr(replace(gen_random_uuid()::text, '-', ''), 1, 4);

  INSERT INTO orders (
    tenant_id, customer_id, customer_name, order_number, order_type,
    order_source, status, total_amount, vat_amount, paid_amount, outstanding_amount,
    payment_method, payment_status,
    sales_qty, revenue, confirmed_amount, order_qty,
    is_processed, has_pending,
    memo
  ) VALUES (
    p_tenant_id, v_first.customer_id, v_first.customer_name, v_new_order_number,
    COALESCE(v_first.order_type, 'wholesale'),
    'sample_convert', 'shipped',
    v_total, 0, 0, v_total,
    v_first.payment_method, 'unpaid',
    v_qty, v_total, v_total, v_qty,    -- 처음부터 매출 박제
    TRUE, FALSE,                        -- is_processed=TRUE → trg refresh no-op
    '샘플 매입 전환 묶음 (' || v_count || '건)'
  )
  RETURNING id INTO v_new_order_id;

  -- 4) order_items 다건 INSERT (trg refresh 가 발동해도 v_increment=0 → no-op)
  FOREACH v_id IN ARRAY v_ids
  LOOP
    SELECT variant_id, quantity, unit_price
    INTO v_item
    FROM order_items WHERE id = v_id;

    INSERT INTO order_items (
      order_id, variant_id, quantity, original_quantity, remaining_qty,
      unit_price, total_price, status, process_type,
      shipped_qty, shipped_at, is_sample, is_exchange,
      sample_status, sample_due_date
    ) VALUES (
      v_new_order_id, v_item.variant_id, v_item.quantity, v_item.quantity, 0,
      v_item.unit_price, v_item.quantity * v_item.unit_price, 'shipped', 'ordered',
      v_item.quantity, NOW(), FALSE, FALSE,
      NULL, NULL
    );
  END LOOP;

  -- 5) transactions(shipment) — 단일 행 박제 (RPC 가 직접)
  --    071 trg_fill_biz_session_id 가 biz_session_id 자동 채움.
  INSERT INTO transactions (
    tenant_id, customer_id, source, type, method,
    amount, transaction_date, order_id
  ) VALUES (
    p_tenant_id, v_first.customer_id, 'shipment', 'receivable',
    v_first.payment_method, v_total, CURRENT_DATE, v_new_order_id
  );

  -- 6) customers.outstanding_balance += v_total
  --    132 sync trigger 가 COMMIT 시 SUM 으로 정정 — 같은 값이라 결과 동일.
  UPDATE customers
  SET outstanding_balance = COALESCE(outstanding_balance, 0) + v_total
  WHERE id = v_first.customer_id AND tenant_id = p_tenant_id;

  -- 7) 매입금 자동 충당 분기 (이전 -외상 있으면 그만큼 paid 처리)
  IF v_balance_before < 0 THEN
    v_credit_used := LEAST(ABS(v_balance_before)::BIGINT, v_total);

    UPDATE orders
    SET paid_amount        = COALESCE(paid_amount, 0) + v_credit_used,
        outstanding_amount = GREATEST(0, outstanding_amount - v_credit_used),
        payment_status     = CASE
          WHEN GREATEST(0, outstanding_amount - v_credit_used) = 0 THEN 'paid'
          WHEN COALESCE(paid_amount, 0) + v_credit_used > 0 THEN 'partial'
          ELSE payment_status
        END
    WHERE id = v_new_order_id;

    INSERT INTO transactions (
      tenant_id, customer_id, source, type, method,
      amount, transaction_date, order_id, description
    ) VALUES (
      p_tenant_id, v_first.customer_id, 'credit_apply', 'income', NULL,
      v_credit_used, CURRENT_DATE, v_new_order_id, '매입금 자동 충당'
    );
  END IF;

  -- 8) 영수증 박제 — 단일 호출 (109 logic: 결제수단별 당잔 자동 계산)
  PERFORM issue_receipt_snapshot(v_new_order_id, v_balance_before);

  RETURN json_build_object(
    'success', true,
    'new_order_id', v_new_order_id,
    'new_order_number', v_new_order_number,
    'amount', v_total,
    'count', v_count
  );
END;
$$;

GRANT EXECUTE ON FUNCTION convert_samples_bulk(JSONB, UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION convert_samples_bulk(JSONB, UUID) TO anon;

NOTIFY pgrst, 'reload schema';
