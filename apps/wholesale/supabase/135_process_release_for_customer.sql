-- ============================================================
-- 135: 미송/보류 해제 시 derived 주문 + 음수 영수증 발행
--
-- 사장 요구: 미송 해제 시 -영수증 (음수 매출 derived 주문) 발행.
-- 여러 항목 [처리!] 시 거래처별 묶음 (frontend 에서 거래처별 group 후 각 거래처마다 호출).
--
-- 동작:
--   1. 입력 항목들을 close (deduct_inventory p_qty=0, p_close=true)
--   2. 미송(backorder) 항목 합산 → 음수 derived 주문 INSERT
--      - revenue = -X, outstanding = -X, payment_status='paid' (음수라 paid 처리)
--   3. transactions(source='shipment', amount=-X, customer_id 채움)
--      → 132 sync trigger 가 customer outstanding -X 자동 (정합)
--   4. issue_receipt_snapshot 호출 → 영수증 박제 (post = prev + revenue 음수)
--
-- 보류(hold) 항목:
--   - 보류는 외상/매출 인식 X (출고 시점에만 인식)
--   - 해제 시 매출/외상 변동 X. 단지 close 만.
--   - 영수증 발행 X (수량 0 derived 주문 무의미).
--   - 단, 사장이 추후 요구 시 빈 영수증 발행 가능.
--
-- 132 sync trigger 정합:
--   transactions(source='shipment', amount=-X) → trigger CASE shipment THEN amount = -X
--   manual customer UPDATE -X 와 일치. 정합 ✓
--   order outstanding 도 동일 패턴 (단일 derived 주문 SUM = -X).
--
-- 074-077 매출 통계:
--   transactions(source='shipment') 음수 → 매출 합산 자동 차감.
-- ============================================================

CREATE OR REPLACE FUNCTION process_release_for_customer(
  p_tenant_id   UUID,
  p_customer_id UUID,
  p_items       JSONB  -- [{"item_id": uuid, "qty": int}, ...]
) RETURNS JSON LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_orig             RECORD;
  v_new_order_id     UUID;
  v_new_order_number TEXT;
  v_total_amount     NUMERIC := 0;
  v_total_qty        INT     := 0;
  v_balance_before   NUMERIC;
  v_payload          JSONB;
  v_item_id          UUID;
  v_qty              INT;
  v_item             RECORD;
  v_first_order_id   UUID;
BEGIN
  PERFORM assert_tenant_access(p_tenant_id);

  IF p_items IS NULL OR jsonb_array_length(p_items) = 0 THEN
    RETURN json_build_object('success', false, 'error', '항목이 비어있습니다.');
  END IF;

  -- 첫 항목으로 원본 주문 정보 (영수증 메타용)
  SELECT o.id AS order_id, o.customer_name, o.payment_method, o.order_number, o.order_type
  INTO v_orig
  FROM order_items oi
  JOIN orders o ON o.id = oi.order_id
  WHERE oi.id = (p_items->0->>'item_id')::UUID
    AND o.tenant_id = p_tenant_id
    AND o.customer_id = p_customer_id;

  IF NOT FOUND THEN
    RETURN json_build_object('success', false, 'error', '첫 항목을 찾을 수 없습니다.');
  END IF;
  v_first_order_id := v_orig.order_id;

  -- 거래처 외상 snapshot (영수증 박제용)
  SELECT outstanding_balance INTO v_balance_before
  FROM customers WHERE id = p_customer_id;

  -- 각 항목 close + 미송분 합산
  FOR v_payload IN SELECT * FROM jsonb_array_elements(p_items)
  LOOP
    v_item_id := (v_payload->>'item_id')::UUID;
    v_qty     := (v_payload->>'qty')::INT;

    SELECT oi.id, oi.variant_id, oi.unit_price, oi.remaining_qty, oi.process_type, o.customer_id
    INTO v_item
    FROM order_items oi
    JOIN orders o ON o.id = oi.order_id
    WHERE oi.id = v_item_id AND o.tenant_id = p_tenant_id;

    IF NOT FOUND THEN CONTINUE; END IF;
    IF v_item.process_type NOT IN ('backorder', 'hold') THEN CONTINUE; END IF;
    IF v_item.customer_id <> p_customer_id THEN CONTINUE; END IF;

    -- 원 행 close (재고 변동 X, remaining_qty=0, status='shipped')
    PERFORM deduct_inventory(
      p_tenant_id     := p_tenant_id,
      p_variant_id    := v_item.variant_id,
      p_qty           := 0,
      p_order_item_id := v_item_id,
      p_close         := true
    );

    -- 미송만 음수 매출 합산 (보류는 매출 인식 X)
    IF v_item.process_type = 'backorder' THEN
      v_total_amount := v_total_amount + (v_qty * v_item.unit_price);
      v_total_qty    := v_total_qty + v_qty;
    END IF;
  END LOOP;

  -- 미송 해제분이 없으면 영수증 발행 X (보류만 close 한 케이스)
  IF v_total_amount <= 0 THEN
    RETURN json_build_object('success', true, 'new_order_id', NULL, 'amount', 0, 'count', 0);
  END IF;

  -- derived 주문 생성 (음수)
  v_new_order_number := v_orig.order_number || '-R'
    || substr(replace(gen_random_uuid()::text, '-', ''), 1, 4);

  INSERT INTO orders (
    tenant_id, customer_id, customer_name, order_number, order_type,
    order_source, status, payment_method, payment_status,
    total_amount, vat_amount, paid_amount, outstanding_amount,
    derived_from_order_id, is_processed, has_pending,
    sales_qty, revenue, confirmed_amount, order_qty,
    memo
  ) VALUES (
    p_tenant_id, p_customer_id, v_orig.customer_name, v_new_order_number,
    COALESCE(v_orig.order_type, 'wholesale'),
    'backorder_release', 'shipped', v_orig.payment_method, 'paid',
    -v_total_amount, 0, 0, -v_total_amount,
    v_first_order_id, true, false,
    -v_total_qty, -v_total_amount, -v_total_amount, v_total_qty,
    '미송해제 (' || v_total_qty || '개)'
  )
  RETURNING id INTO v_new_order_id;

  -- 외상 차감 (manual + transactions, 132 sync trigger 정합)
  UPDATE customers
  SET outstanding_balance = outstanding_balance - v_total_amount
  WHERE id = p_customer_id AND tenant_id = p_tenant_id;

  INSERT INTO transactions (
    tenant_id, customer_id, source, type, method,
    amount, transaction_date, order_id, description
  ) VALUES (
    p_tenant_id, p_customer_id, 'shipment', 'receivable', v_orig.payment_method,
    -v_total_amount, CURRENT_DATE, v_new_order_id, '미송해제'
  );

  -- 영수증 박제 (109 issue_receipt_snapshot 의 derived 분기: post = prev + revenue 음수)
  PERFORM issue_receipt_snapshot(v_new_order_id, v_balance_before);

  RETURN json_build_object(
    'success',          true,
    'new_order_id',     v_new_order_id,
    'new_order_number', v_new_order_number,
    'amount',           -v_total_amount,
    'count',            v_total_qty
  );
END;
$$;

GRANT EXECUTE ON FUNCTION process_release_for_customer(UUID, UUID, JSONB) TO authenticated;

NOTIFY pgrst, 'reload schema';
