-- ============================================================
-- 124: process_pending_ship — 보류(hold) derived 주문에 외상 직접 박제
--
-- 사장 모델 (2026-05-05):
--   보류 출고 시 derived 주문 = 영수증 발행 + 매출 + 외상 단독 책임.
--   원 주문은 변경 X (사장 원본 보존 원칙).
--
-- 123 부작용 보강:
--   123 가 refresh_order_revenue 의 SUM 에서 hold 출고분 제외 → 원 주문 revenue 0
--   → 그러나 derived 주문도 outstanding=0 으로 INSERT 되어 외상 자체 누락.
--   사장 보고: "보류→출고 시 외상이 올라가야하는데 미동작".
--
-- 패치:
--   process_pending_ship 의 hold_ship 분기에서 derived 주문에 직접 박제:
--   - outstanding_amount = revenue (외상 잡음)
--   - transactions(shipment) INSERT
--   - customers.outstanding_balance += revenue
--   - 매입금 자동 충당 분기 (v_balance_before < 0 이면 차감 + transactions(credit_apply))
--
--   backorder_ship 분기는 그대로 (외상 변동 X, 미송 등록 시 이미 잡힘).
--
-- 영수증 박제:
--   109 issue_receipt_snapshot 가 derived 면 post = prev + revenue 자동 계산.
--   외상이 derived 단독 박제이므로 영수증 잔액 표시도 정합.
--
-- 사장 원칙 보존:
--   원 주문 (process_type='hold') 의 매출/외상 변동 X (123 적용).
--   derived 주문이 매출/외상/영수증 모두 단독 책임.
--   원본 보존 (Phase 7) 의 첫 단계.
-- ============================================================

DROP FUNCTION IF EXISTS process_pending_ship(UUID, UUID, JSONB, TEXT);

CREATE OR REPLACE FUNCTION process_pending_ship(
  p_tenant_id          UUID,
  p_original_order_id  UUID,
  p_item_qty           JSONB,
  p_kind               TEXT
)
RETURNS UUID LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_orig             RECORD;
  v_new_order_id     UUID;
  v_new_order_number TEXT;
  v_total            NUMERIC := 0;
  v_qty              INT     := 0;
  v_revenue          NUMERIC := 0;
  v_sales_qty        INT     := 0;
  v_payload          JSONB;
  v_item             RECORD;
  v_qty_to_ship      INT;
  v_balance_before   NUMERIC;
  v_order_source     TEXT;
  v_suffix           TEXT;
  v_memo_label       TEXT;
  v_initial_outstanding NUMERIC := 0;
  v_credit_used      BIGINT;
BEGIN
  PERFORM assert_tenant_access(p_tenant_id);

  IF p_kind NOT IN ('backorder', 'hold') THEN
    RAISE EXCEPTION 'p_kind 는 backorder 또는 hold 만 허용. 받은: %', p_kind
      USING ERRCODE = 'P0001';
  END IF;

  v_order_source := p_kind || '_ship';
  v_suffix       := CASE p_kind WHEN 'hold' THEN 'O' ELSE 'S' END;
  v_memo_label   := CASE p_kind WHEN 'hold' THEN '보류 출고' ELSE '미송 출고' END;

  SELECT customer_id, customer_name, payment_method, order_number, order_type
  INTO v_orig
  FROM orders WHERE id = p_original_order_id AND tenant_id = p_tenant_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION '원본 주문을 찾을 수 없습니다 (%)', p_original_order_id
      USING ERRCODE = 'P0001';
  END IF;

  SELECT outstanding_balance INTO v_balance_before
  FROM customers WHERE id = v_orig.customer_id;

  -- 1) 각 item 처리
  FOR v_payload IN SELECT * FROM jsonb_array_elements(p_item_qty)
  LOOP
    v_qty_to_ship := (v_payload->>'qty')::INT;

    SELECT id, variant_id, unit_price, remaining_qty, process_type, is_sample, is_exchange
    INTO v_item
    FROM order_items WHERE id = (v_payload->>'item_id')::UUID;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'order_item 을 찾을 수 없습니다 (%)', v_payload->>'item_id'
        USING ERRCODE = 'P0001';
    END IF;
    IF v_item.process_type <> p_kind THEN
      RAISE EXCEPTION 'item process_type (%) != p_kind (%)', v_item.process_type, p_kind
        USING ERRCODE = 'P0001';
    END IF;

    PERFORM deduct_inventory(
      p_tenant_id     := p_tenant_id,
      p_variant_id    := v_item.variant_id,
      p_qty           := v_qty_to_ship,
      p_order_item_id := v_item.id,
      p_close         := v_qty_to_ship >= v_item.remaining_qty
    );

    v_total := v_total + (v_qty_to_ship * v_item.unit_price);
    v_qty   := v_qty + v_qty_to_ship;

    -- 보류만 매출/판매로 인식 (미송은 원본에서 이미 인식됨)
    IF p_kind = 'hold' THEN
      v_revenue   := v_revenue + (v_qty_to_ship * v_item.unit_price);
      v_sales_qty := v_sales_qty + v_qty_to_ship;
    END IF;
  END LOOP;

  -- 2) hold derived 는 외상 잡음 (123 패치 후 원 주문에 안 잡히므로 derived 단독)
  --    backorder derived 는 외상 0 (미송 등록 시 이미 잡힘)
  v_initial_outstanding := CASE WHEN p_kind = 'hold' THEN v_revenue ELSE 0 END;

  -- 3) 신규 derived 주문 생성
  v_new_order_number := v_orig.order_number || '-' || v_suffix
    || substr(replace(gen_random_uuid()::text, '-', ''), 1, 4);

  INSERT INTO orders (
    tenant_id, customer_id, customer_name, order_number, order_type,
    order_source, status, payment_method, payment_status,
    total_amount, vat_amount, paid_amount, outstanding_amount,
    derived_from_order_id, is_processed, has_pending,
    sales_qty, revenue, confirmed_amount, order_qty,
    memo
  ) VALUES (
    p_tenant_id, v_orig.customer_id, v_orig.customer_name, v_new_order_number,
    COALESCE(v_orig.order_type, 'wholesale'),
    v_order_source, 'shipped', v_orig.payment_method, 'unpaid',
    v_total, 0, 0, v_initial_outstanding,
    p_original_order_id, true, false,
    v_sales_qty, v_revenue, v_revenue, v_qty,
    v_memo_label || ' (원본: ' || v_orig.order_number || ')'
  )
  RETURNING id INTO v_new_order_id;

  -- 4) derived 주문 order_items 복사
  FOR v_payload IN SELECT * FROM jsonb_array_elements(p_item_qty)
  LOOP
    v_qty_to_ship := (v_payload->>'qty')::INT;
    SELECT variant_id, unit_price, is_sample, is_exchange
    INTO v_item
    FROM order_items WHERE id = (v_payload->>'item_id')::UUID;

    INSERT INTO order_items (
      order_id, variant_id, quantity, original_quantity, remaining_qty,
      unit_price, total_price, status, process_type,
      shipped_qty, shipped_at, is_sample, is_exchange
    ) VALUES (
      v_new_order_id, v_item.variant_id, v_qty_to_ship, v_qty_to_ship, 0,
      v_item.unit_price, v_qty_to_ship * v_item.unit_price, 'shipped', 'ordered',
      v_qty_to_ship, NOW(), v_item.is_sample, v_item.is_exchange
    );
  END LOOP;

  -- 5) hold derived: 외상/transactions/매입금 충당 직접 박제
  IF p_kind = 'hold' AND v_revenue > 0 THEN
    INSERT INTO transactions (
      tenant_id, customer_id, source, type, method,
      amount, transaction_date, order_id
    ) VALUES (
      p_tenant_id, v_orig.customer_id, 'shipment', 'receivable', v_orig.payment_method,
      v_revenue, CURRENT_DATE, v_new_order_id
    );

    UPDATE customers
    SET outstanding_balance = outstanding_balance + v_revenue
    WHERE id = v_orig.customer_id;

    -- 매입금 자동 충당 (109 패턴 동일)
    IF v_balance_before < 0 THEN
      v_credit_used := LEAST(ABS(v_balance_before)::BIGINT, v_revenue::BIGINT);
      UPDATE orders
      SET paid_amount        = COALESCE(paid_amount, 0) + v_credit_used,
          outstanding_amount = GREATEST(0, outstanding_amount - v_credit_used),
          payment_status     = CASE
            WHEN outstanding_amount - v_credit_used <= 0 THEN 'paid'
            WHEN v_credit_used > 0 THEN 'partial'
            ELSE payment_status
          END
      WHERE id = v_new_order_id;
      INSERT INTO transactions (
        tenant_id, customer_id, source, type, method,
        amount, transaction_date, order_id, description
      ) VALUES (
        p_tenant_id, v_orig.customer_id, 'credit_apply', 'income', NULL,
        v_credit_used, CURRENT_DATE, v_new_order_id, '매입금 자동 충당'
      );
    END IF;
  END IF;

  -- 6) 원본 주문 refresh — 123 후 hold 출고분 제외이므로 revenue 변동 X (정상)
  --    backorder 의 경우도 remaining_qty 변동 + shipped_qty 변동 합계 동일 (변동 X)
  PERFORM refresh_order_revenue(p_original_order_id);

  -- 7) 영수증 박제 — 107 안전망: derived 면 issue_receipt_snapshot 안에서 v_post = prev + revenue
  PERFORM issue_receipt_snapshot(v_new_order_id, v_balance_before);

  RETURN v_new_order_id;
END;
$$;

GRANT EXECUTE ON FUNCTION process_pending_ship(UUID, UUID, JSONB, TEXT) TO authenticated;
