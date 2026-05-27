-- ============================================================
-- 141: process_return_derived 잔량 초과 차단
--
-- 사장 정책 (2026-05-06):
--   반품/교환은 원 라인의 (shipped_qty - 누적반품량) 까지만 가능.
--   현재는 1개 출고 후 1개 반품해도 또 반품 가능 → 누적 검증 누락.
--
-- 누적 반품량 출처:
--   inventory_logs.qty_change SUM WHERE order_item_id=원라인 AND reason IN ('return','exchange')
--   → 마이그 140 가 이미 박제 중. 추가 컬럼 X.
--
-- 검증 위치:
--   FOR loop 안. 각 라인별 잔량 검증. 초과 시 RAISE EXCEPTION → 트랜잭션 롤백
--   (derived 주문 INSERT 도 자동 롤백, 데이터 정합 보장).
-- ============================================================

DROP FUNCTION IF EXISTS process_return_derived(UUID, UUID, JSONB, TEXT);

CREATE OR REPLACE FUNCTION process_return_derived(
  p_tenant_id  UUID,
  p_order_id   UUID,
  p_items      JSONB,
  p_reason     TEXT DEFAULT 'return'
) RETURNS JSON LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_orig             RECORD;
  v_new_order_id     UUID;
  v_new_order_number TEXT;
  v_total            NUMERIC := 0;
  v_qty              INT     := 0;
  v_balance_before   NUMERIC;
  v_payload          JSONB;
  v_item_id          UUID;
  v_qty_to_return    INT;
  v_item             RECORD;
  v_inv_qty          INT;
  v_label            TEXT;
  v_already_returned INT;
  v_returnable       INT;
BEGIN
  PERFORM assert_tenant_access(p_tenant_id);

  IF p_items IS NULL OR jsonb_array_length(p_items) = 0 THEN
    RETURN json_build_object('success', false, 'error', '항목이 비어있습니다.');
  END IF;

  IF p_reason NOT IN ('return', 'exchange') THEN
    RETURN json_build_object('success', false, 'error', 'p_reason 은 return 또는 exchange 만 허용');
  END IF;

  v_label := CASE p_reason WHEN 'exchange' THEN '교환반품' ELSE '반품' END;

  SELECT customer_id, customer_name, payment_method, order_number, order_type
  INTO v_orig
  FROM orders WHERE id = p_order_id AND tenant_id = p_tenant_id;

  IF NOT FOUND THEN
    RETURN json_build_object('success', false, 'error', '원 주문을 찾을 수 없습니다.');
  END IF;

  SELECT outstanding_balance INTO v_balance_before
  FROM customers WHERE id = v_orig.customer_id;

  v_new_order_number := v_orig.order_number || '-RT'
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
    'return', 'shipped', v_orig.payment_method, 'paid',
    0, 0, 0, 0,
    p_order_id, true, false,
    0, 0, 0, 0,
    v_label || ' (원본: ' || v_orig.order_number || ')'
  )
  RETURNING id INTO v_new_order_id;

  FOR v_payload IN SELECT * FROM jsonb_array_elements(p_items)
  LOOP
    v_item_id       := (v_payload->>'item_id')::UUID;
    v_qty_to_return := (v_payload->>'qty')::INT;

    IF v_qty_to_return <= 0 THEN CONTINUE; END IF;

    SELECT id, variant_id, unit_price, is_sample, shipped_qty
    INTO v_item
    FROM order_items WHERE id = v_item_id;
    IF NOT FOUND THEN CONTINUE; END IF;

    -- 누적 반품량 계산 (inventory_logs 에서 reason='return'/'exchange' SUM)
    SELECT COALESCE(SUM(qty_change), 0) INTO v_already_returned
    FROM inventory_logs
    WHERE order_item_id = v_item_id AND reason IN ('return', 'exchange');

    v_returnable := v_item.shipped_qty - v_already_returned;

    IF v_qty_to_return > v_returnable THEN
      RAISE EXCEPTION '반품 가능 수량 초과 — 출고: %, 이미 반품: %, 가능 잔량: %, 요청: %',
        v_item.shipped_qty, v_already_returned, v_returnable, v_qty_to_return
        USING ERRCODE = 'P0001';
    END IF;

    -- 재고 복원 (원 라인의 shipped_qty 그대로 — 박제 보존)
    UPDATE inventory
    SET quantity = quantity + v_qty_to_return,
        updated_at = NOW()
    WHERE tenant_id = p_tenant_id AND variant_id = v_item.variant_id
    RETURNING quantity INTO v_inv_qty;

    INSERT INTO inventory_logs (
      tenant_id, variant_id, order_item_id, qty_change, balance_after, reason
    ) VALUES (
      p_tenant_id, v_item.variant_id, v_item_id, v_qty_to_return,
      COALESCE(v_inv_qty, 0), p_reason
    );

    INSERT INTO order_items (
      order_id, variant_id, quantity, original_quantity, remaining_qty,
      unit_price, total_price, status, process_type,
      shipped_qty, shipped_at, is_sample, is_exchange
    ) VALUES (
      v_new_order_id, v_item.variant_id, v_qty_to_return, v_qty_to_return, 0,
      v_item.unit_price, v_qty_to_return * v_item.unit_price, 'shipped', 'ordered',
      v_qty_to_return, NOW(), v_item.is_sample, false
    );

    v_total := v_total + (v_qty_to_return * v_item.unit_price);
    v_qty   := v_qty + v_qty_to_return;
  END LOOP;

  IF v_total <= 0 THEN
    DELETE FROM orders WHERE id = v_new_order_id;
    RETURN json_build_object('success', true, 'new_order_id', NULL, 'amount', 0, 'count', 0);
  END IF;

  UPDATE orders
  SET total_amount       = -v_total,
      outstanding_amount = -v_total,
      sales_qty          = -v_qty,
      revenue            = -v_total,
      confirmed_amount   = -v_total,
      order_qty          = v_qty
  WHERE id = v_new_order_id;

  UPDATE customers
  SET outstanding_balance = outstanding_balance - v_total
  WHERE id = v_orig.customer_id AND tenant_id = p_tenant_id;

  INSERT INTO transactions (
    tenant_id, customer_id, source, type, method,
    amount, transaction_date, order_id, description
  ) VALUES (
    p_tenant_id, v_orig.customer_id, 'return', 'income', v_orig.payment_method,
    v_total, CURRENT_DATE, v_new_order_id, v_label
  );

  PERFORM issue_receipt_snapshot(v_new_order_id, v_balance_before);

  RETURN json_build_object(
    'success',          true,
    'new_order_id',     v_new_order_id,
    'new_order_number', v_new_order_number,
    'amount',           -v_total,
    'count',            v_qty
  );
END;
$$;

GRANT EXECUTE ON FUNCTION process_return_derived(UUID, UUID, JSONB, TEXT) TO authenticated;

NOTIFY pgrst, 'reload schema';
