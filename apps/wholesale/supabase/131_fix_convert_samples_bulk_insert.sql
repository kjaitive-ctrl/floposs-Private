-- ============================================================
-- 131: 샘결 버그 수정 — convert_samples_bulk INSERT 명시화
--
-- 사장 보고 (2026-05-05): 샘결 시 샘결주문서에 "판매/당일" 안 잡힘 (외상은 잡힘)
--
-- 원인:
--   118 convert_samples_bulk 의 orders INSERT 시 sales_qty/revenue/
--   is_processed/has_pending 등 미명시 → DEFAULT 의존.
--   is_processed DEFAULT 가 NULL 이거나 누락된 경우, 109 refresh_order_revenue
--   의 첫 처리 분기 조건 (v_is_processed AND NOT v_prev_processed) 가
--   NULL 평가 → 분기 SKIP → transactions(shipment) 박제 X / 영수증 박제 X.
--
-- 수정:
--   118 의 INSERT 시 모든 박제 컬럼 명시:
--   - sales_qty=0, revenue=0, confirmed_amount=0, order_qty=0
--   - is_processed=FALSE, has_pending=FALSE
--   → 109 refresh 가 첫 처리 분기 정상 진입 (v_prev_processed=FALSE 보장)
--   → 매출/외상/영수증 박제 정합
--
-- 추가 안전망:
--   trg_order_items_revenue 가 매 INSERT 마다 발동. 마지막 명시 PERFORM 도
--   유지 (멱등 — 결과 동일).
--
-- 영향 함수: convert_samples_bulk(JSONB, UUID) 만 변경. 다른 RPC 영향 X.
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
  v_new_order_id     UUID;
  v_new_order_number TEXT;
  v_count            INT     := 0;
  v_id               UUID;
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

  -- 2) 신규 주문 INSERT (모든 박제 컬럼 명시 — 109 refresh 첫 처리 분기 보장)
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
    0, 0, 0, 0,                 -- 박제 컬럼 0 으로 시작 (refresh 가 갱신)
    FALSE, FALSE,                -- is_processed=FALSE → refresh 가 첫 처리 분기 진입
    '샘플 매입 전환 묶음 (' || v_count || '건)'
  )
  RETURNING id INTO v_new_order_id;

  -- 3) order_items 다건 INSERT
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

  -- 4) 안전망: 명시 refresh (멱등)
  PERFORM refresh_order_revenue(v_new_order_id);

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
