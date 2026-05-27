-- ============================================================
-- 166: process_release_for_customer transactions source 정정 (2026-05-08 사장 보고)
--
-- 버그:
--   영업정산 매출 = 81만 → 66만 → totalSales 63만.
--   영수증 기준 매출 81만, 반품 -18만 (반품 3만 + 미송해제 15만) 과 분류 어긋남.
--
-- 원인:
--   162 process_release_for_customer: 미송해제 transactions 를 source='shipment' / amount=-N
--   으로 박제. 영업정산 분류 (source='shipment' = 매출) 가 -N 을 매출에 합산 → 매출 차감.
--
-- 수정:
--   미송해제도 회계상 반품과 동일 (출고 취소, 외상 차감, 음수 영수증). source='return' 통일.
--   process_return_derived 와 동일 패턴 (source='return' / type='income' / amount=양수).
--
-- 효과:
--   sync_balance_from_transactions 의 SUM 부호 룰: shipment +amount, return -amount.
--   shipment(-N) 과 return(+N) 모두 외상 -N 효과로 정합.
--
-- 추가:
--   기존 데이터 정정 (사장 테스트 환경) — source='shipment' AND amount<0 AND description='미송해제'.
-- ============================================================

BEGIN;

CREATE OR REPLACE FUNCTION process_release_for_customer(
  p_tenant_id UUID, p_customer_id UUID, p_items JSONB
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
  v_clamped          JSONB := '[]'::JSONB;
  v_vat_rate         NUMERIC;
  v_orig_vat         NUMERIC;
  v_orig_vat_in_payment BOOLEAN;
  v_neg_vat          BIGINT := 0;
BEGIN
  PERFORM assert_tenant_access(p_tenant_id);
  IF p_items IS NULL OR jsonb_array_length(p_items) = 0 THEN
    RETURN json_build_object('success', false, 'error', '항목이 비어있습니다.');
  END IF;

  SELECT o.id AS order_id, o.customer_name, o.payment_method, o.order_number, o.order_type, o.vat_amount AS orig_vat
  INTO v_orig
  FROM order_items oi JOIN orders o ON o.id = oi.order_id
  WHERE oi.id = (p_items->0->>'item_id')::UUID
    AND o.tenant_id = p_tenant_id AND o.customer_id = p_customer_id;
  IF NOT FOUND THEN RETURN json_build_object('success', false, 'error', '첫 항목을 찾을 수 없습니다.'); END IF;
  v_first_order_id := v_orig.order_id;
  v_orig_vat := COALESCE(v_orig.orig_vat, 0);
  v_orig_vat_in_payment := v_orig_vat > 0;

  SELECT outstanding_balance INTO v_balance_before FROM customers WHERE id = p_customer_id;
  SELECT COALESCE(vat_rate, 0.10) INTO v_vat_rate FROM tenants WHERE id = p_tenant_id;

  FOR v_payload IN SELECT * FROM jsonb_array_elements(p_items)
  LOOP
    v_item_id := (v_payload->>'item_id')::UUID;
    v_qty     := (v_payload->>'qty')::INT;

    SELECT oi.id, oi.variant_id, oi.unit_price, oi.process_type, oi.is_sample, oi.is_exchange,
           oi.remaining_qty, o.customer_id
    INTO v_item
    FROM order_items oi JOIN orders o ON o.id = oi.order_id
    WHERE oi.id = v_item_id AND o.tenant_id = p_tenant_id;
    IF NOT FOUND THEN CONTINUE; END IF;
    IF v_item.process_type NOT IN ('backorder', 'hold') THEN CONTINUE; END IF;
    IF v_item.customer_id <> p_customer_id THEN CONTINUE; END IF;
    IF v_item.remaining_qty <= 0 THEN CONTINUE; END IF;
    IF v_qty > v_item.remaining_qty THEN v_qty := v_item.remaining_qty; END IF;
    IF v_qty <= 0 THEN CONTINUE; END IF;

    UPDATE order_items
    SET remaining_qty = GREATEST(0, remaining_qty - v_qty),
        status = CASE WHEN GREATEST(0, remaining_qty - v_qty) = 0 THEN 'shipped' ELSE status END,
        updated_at = NOW()
    WHERE id = v_item_id;

    IF v_item.process_type = 'backorder' THEN
      v_total_amount := v_total_amount + (v_qty * v_item.unit_price);
      v_total_qty    := v_total_qty + v_qty;
      v_clamped := v_clamped || jsonb_build_object(
        'item_id', v_item_id, 'qty', v_qty,
        'variant_id', v_item.variant_id, 'unit_price', v_item.unit_price,
        'is_sample', v_item.is_sample, 'is_exchange', v_item.is_exchange
      );
    END IF;
  END LOOP;

  IF v_total_amount <= 0 THEN
    RETURN json_build_object('success', true, 'new_order_id', NULL, 'amount', 0, 'count', 0);
  END IF;

  v_neg_vat := ROUND(v_total_amount * v_vat_rate)::BIGINT;

  v_new_order_number := v_orig.order_number || '-R'
    || substr(replace(gen_random_uuid()::text, '-', ''), 1, 4);

  INSERT INTO orders (
    tenant_id, customer_id, customer_name, order_number, order_type,
    order_source, status, payment_method, payment_status,
    total_amount, vat_amount, paid_amount, outstanding_amount,
    derived_from_order_id, is_processed, has_pending,
    sales_qty, revenue, confirmed_amount, order_qty, memo
  ) VALUES (
    p_tenant_id, p_customer_id, v_orig.customer_name, v_new_order_number,
    COALESCE(v_orig.order_type, 'wholesale'),
    'backorder_release', 'shipped', v_orig.payment_method, 'paid',
    -v_total_amount, CASE WHEN v_orig_vat_in_payment THEN -v_neg_vat ELSE 0 END,
    0, -v_total_amount,
    v_first_order_id, true, false,
    -v_total_qty, -v_total_amount, -v_total_amount, v_total_qty,
    '미송해제 (' || v_total_qty || '개)'
  ) RETURNING id INTO v_new_order_id;

  FOR v_payload IN SELECT * FROM jsonb_array_elements(v_clamped)
  LOOP
    v_qty := (v_payload->>'qty')::INT;
    INSERT INTO order_items (
      order_id, variant_id, quantity, original_quantity, remaining_qty,
      unit_price, total_price, status, process_type,
      shipped_qty, shipped_at, is_sample, is_exchange
    ) VALUES (
      v_new_order_id,
      (v_payload->>'variant_id')::UUID,
      v_qty, v_qty, 0,
      (v_payload->>'unit_price')::NUMERIC,
      v_qty * (v_payload->>'unit_price')::NUMERIC,
      'shipped', 'ordered',
      v_qty, NOW(),
      (v_payload->>'is_sample')::BOOLEAN,
      (v_payload->>'is_exchange')::BOOLEAN
    );
  END LOOP;

  -- 166 변경: source='return' / type='income' / amount=양수 (process_return_derived 와 동일 패턴)
  INSERT INTO transactions (tenant_id, customer_id, source, type, method, amount, vat_type, transaction_date, order_id, description)
  VALUES (p_tenant_id, p_customer_id, 'return', 'income', v_orig.payment_method, v_total_amount, 'supply', CURRENT_DATE, v_new_order_id, '미송해제');
  IF v_neg_vat > 0 THEN
    INSERT INTO transactions (tenant_id, customer_id, source, type, method, amount, vat_type, transaction_date, order_id, description)
    VALUES (p_tenant_id, p_customer_id, 'return', 'income', v_orig.payment_method, v_neg_vat, 'vat', CURRENT_DATE, v_new_order_id, '미송해제');
  END IF;

  UPDATE customers
  SET outstanding_balance = outstanding_balance - v_total_amount,
      outstanding_vat     = outstanding_vat - v_neg_vat
  WHERE id = p_customer_id AND tenant_id = p_tenant_id;

  PERFORM issue_receipt_snapshot(v_new_order_id, v_balance_before);

  RETURN json_build_object(
    'success', true, 'new_order_id', v_new_order_id, 'new_order_number', v_new_order_number,
    'amount', -v_total_amount, 'count', v_total_qty
  );
END;
$$;

GRANT EXECUTE ON FUNCTION process_release_for_customer(UUID, UUID, JSONB) TO authenticated;


-- ── 기존 데이터 정정 ────────────────────────────────
-- source='shipment' AND amount<0 AND description='미송해제' 행을 'return' / amount=양수 로 변환.
-- sync_balance_from_transactions 트리거가 SUM 재계산 → outstanding_balance / outstanding_vat 정합 유지.
UPDATE transactions
SET source = 'return',
    type   = 'income',
    amount = -amount
WHERE source = 'shipment'
  AND amount < 0
  AND description = '미송해제';

NOTIFY pgrst, 'reload schema';

COMMIT;
