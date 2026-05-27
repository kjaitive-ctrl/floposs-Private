-- ============================================================
-- 168: process_pending_ship 거래처 단위 통합 (2026-05-08 사장 보고)
--
-- 배경:
--   "미송탭에서 여러개 선택해서 출고했는데 같은 거래처인데도 영수증이 2개 나왔어"
--   = 미송 등록을 2번 한 경우 backorder_register derived 가 2개. 출고 시 부모 derived 별
--     RPC 호출 → 영수증 2개. 167 거래처 단위 매트릭스 위반.
--
-- 변경:
--   process_pending_ship 시그니처: p_original_order_id UUID → p_original_order_ids UUID[]
--   같은 거래처 + 같은 kind (backorder | hold) 의 다중 부모 derived 묶음 → 한 derived = 한 영수증
--
-- 매출/vat/외상:
--   backorder_ship: 매출 변동 X (이미 backorder_register 시점에 박제됨)
--   hold_ship:      매출 첫 박제 (보류 → 출고 시점에 외상 +)
--
-- 의존성:
--   163, 165, 167 적용 후. issue_receipt_snapshot / deduct_inventory / sync trigger 그대로.
-- ============================================================

BEGIN;

DROP FUNCTION IF EXISTS public.process_pending_ship(UUID, UUID, JSONB, TEXT);
DROP FUNCTION IF EXISTS public.process_pending_ship(UUID, UUID[], JSONB, TEXT);

CREATE OR REPLACE FUNCTION public.process_pending_ship(
  p_tenant_id           UUID,
  p_customer_id         UUID,
  p_original_order_ids  UUID[],
  p_item_qty            JSONB,
  p_kind                TEXT
)
RETURNS UUID LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_first_parent        RECORD;
  v_first_parent_id     UUID;
  v_new_order_id        UUID;
  v_new_order_number    TEXT;
  v_total               NUMERIC := 0;
  v_qty                 INT     := 0;
  v_revenue             NUMERIC := 0;
  v_sales_qty           INT     := 0;
  v_payload             JSONB;
  v_item                RECORD;
  v_qty_to_ship         INT;
  v_balance_before      NUMERIC;
  v_order_source        TEXT;
  v_suffix              TEXT;
  v_memo_label          TEXT;
  v_initial_outstanding NUMERIC := 0;
  v_credit_supply       BIGINT;
  v_credit_vat          BIGINT;
  v_old_vat_balance     NUMERIC;
  v_vat_rate            NUMERIC;
  v_orig_vat_in_payment BOOLEAN;
  v_inc_vat             BIGINT := 0;
  v_new_vat_amount      NUMERIC;
BEGIN
  PERFORM assert_tenant_access(p_tenant_id);

  IF p_kind NOT IN ('backorder', 'hold') THEN
    RAISE EXCEPTION 'p_kind 는 backorder 또는 hold 만 허용' USING ERRCODE = 'P0001';
  END IF;
  IF p_original_order_ids IS NULL OR array_length(p_original_order_ids, 1) IS NULL THEN
    RAISE EXCEPTION '부모 derived 가 비어있습니다' USING ERRCODE = 'P0001';
  END IF;

  v_order_source := p_kind || '_ship';
  v_suffix       := CASE p_kind WHEN 'hold' THEN 'O' ELSE 'S' END;
  v_memo_label   := CASE p_kind WHEN 'hold' THEN '보류 출고' ELSE '미송 출고' END;

  -- 첫 parent derived 메타 (vat_in_payment / payment_method / order_number 베이스)
  SELECT id, customer_id, customer_name, payment_method, order_number, order_type, vat_amount
  INTO v_first_parent
  FROM orders
  WHERE id = ANY(p_original_order_ids)
    AND tenant_id = p_tenant_id
    AND customer_id = p_customer_id
  ORDER BY created_at ASC
  LIMIT 1;
  IF NOT FOUND THEN
    RAISE EXCEPTION '부모 derived 를 찾을 수 없거나 거래처가 다릅니다' USING ERRCODE='P0001';
  END IF;
  v_first_parent_id := v_first_parent.id;

  -- 검증: 모든 parent derived 의 customer_id 일치
  IF EXISTS (
    SELECT 1 FROM orders
    WHERE id = ANY(p_original_order_ids)
      AND (customer_id <> p_customer_id OR tenant_id <> p_tenant_id)
  ) THEN
    RAISE EXCEPTION 'parent derived 검증 실패 (다른 거래처 포함)' USING ERRCODE='P0001';
  END IF;

  v_orig_vat_in_payment := COALESCE(v_first_parent.vat_amount, 0) > 0;

  SELECT COALESCE(outstanding_balance, 0), COALESCE(outstanding_vat, 0)
  INTO v_balance_before, v_old_vat_balance
  FROM customers WHERE id = p_customer_id;

  SELECT COALESCE(vat_rate, 0.10) INTO v_vat_rate FROM tenants WHERE id = p_tenant_id;

  -- 출고 처리 (item 별) — 부모 derived 무관 한 번에
  FOR v_payload IN SELECT * FROM jsonb_array_elements(p_item_qty)
  LOOP
    v_qty_to_ship := (v_payload->>'qty')::INT;
    SELECT id, variant_id, unit_price, remaining_qty, process_type, is_sample, is_exchange, order_id
    INTO v_item FROM order_items
    WHERE id = (v_payload->>'item_id')::UUID
      AND order_id = ANY(p_original_order_ids);
    IF NOT FOUND OR v_item.process_type <> p_kind THEN CONTINUE; END IF;

    PERFORM deduct_inventory(
      p_tenant_id     := p_tenant_id,
      p_variant_id    := v_item.variant_id,
      p_qty           := v_qty_to_ship,
      p_order_item_id := v_item.id,
      p_close         := v_qty_to_ship >= v_item.remaining_qty
    );

    v_total := v_total + (v_qty_to_ship * v_item.unit_price);
    v_qty   := v_qty + v_qty_to_ship;

    IF p_kind = 'hold' AND NOT v_item.is_sample THEN
      v_revenue   := v_revenue + (v_qty_to_ship * v_item.unit_price);
      v_sales_qty := v_sales_qty + v_qty_to_ship;
    END IF;
  END LOOP;

  IF v_qty <= 0 THEN
    RAISE EXCEPTION '출고할 수량이 없습니다' USING ERRCODE='P0001';
  END IF;

  v_initial_outstanding := CASE WHEN p_kind = 'hold' THEN v_revenue ELSE 0 END;
  v_new_vat_amount := CASE WHEN v_orig_vat_in_payment THEN ROUND(v_total * v_vat_rate) ELSE 0 END;
  v_inc_vat := CASE WHEN p_kind = 'hold' THEN ROUND(v_revenue * v_vat_rate)::BIGINT ELSE 0 END;

  v_new_order_number := v_first_parent.order_number || '-' || v_suffix
    || substr(replace(gen_random_uuid()::text, '-', ''), 1, 4);

  INSERT INTO orders (
    tenant_id, customer_id, customer_name, order_number, order_type,
    order_source, status, payment_method, payment_status,
    total_amount, vat_amount, paid_amount, outstanding_amount,
    derived_from_order_id, is_processed, has_pending,
    sales_qty, revenue, confirmed_amount, order_qty, memo
  ) VALUES (
    p_tenant_id, p_customer_id, v_first_parent.customer_name, v_new_order_number,
    COALESCE(v_first_parent.order_type, 'wholesale'),
    v_order_source, 'shipped', v_first_parent.payment_method, 'unpaid',
    v_total, v_new_vat_amount, 0, v_initial_outstanding,
    v_first_parent_id, true, false,
    v_sales_qty, v_revenue, v_revenue, v_qty,
    v_memo_label || ' (' || v_qty || '개)'
  )
  RETURNING id INTO v_new_order_id;

  -- order_items 복사 (출고 line 들)
  FOR v_payload IN SELECT * FROM jsonb_array_elements(p_item_qty)
  LOOP
    v_qty_to_ship := (v_payload->>'qty')::INT;
    SELECT variant_id, unit_price, is_sample, is_exchange
    INTO v_item FROM order_items WHERE id = (v_payload->>'item_id')::UUID;
    IF NOT FOUND THEN CONTINUE; END IF;

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

  -- 보류 출고만 매출/외상/vat 첫 박제
  IF p_kind = 'hold' AND v_revenue > 0 THEN
    INSERT INTO transactions (tenant_id, customer_id, source, type, method, amount, vat_type, transaction_date, order_id)
    VALUES (p_tenant_id, p_customer_id, 'shipment', 'receivable', v_first_parent.payment_method, v_revenue, 'supply', CURRENT_DATE, v_new_order_id);
    IF v_inc_vat > 0 THEN
      INSERT INTO transactions (tenant_id, customer_id, source, type, method, amount, vat_type, transaction_date, order_id)
      VALUES (p_tenant_id, p_customer_id, 'shipment', 'receivable', v_first_parent.payment_method, v_inc_vat, 'vat', CURRENT_DATE, v_new_order_id);
    END IF;

    UPDATE customers
    SET outstanding_balance = outstanding_balance + v_revenue,
        outstanding_vat     = outstanding_vat + v_inc_vat
    WHERE id = p_customer_id;

    -- 매입금 충당 (supply / vat 분리)
    IF v_balance_before < 0 THEN
      v_credit_supply := LEAST(ABS(v_balance_before)::BIGINT, v_revenue::BIGINT);
      INSERT INTO transactions (tenant_id, customer_id, source, type, method, amount, vat_type, transaction_date, order_id, description)
      VALUES (p_tenant_id, p_customer_id, 'credit_apply', 'income', NULL, v_credit_supply, 'supply', CURRENT_DATE, v_new_order_id, '매입금 자동 충당 (공급가)');
      UPDATE orders
      SET paid_amount        = COALESCE(paid_amount, 0) + v_credit_supply,
          outstanding_amount = GREATEST(0, outstanding_amount - v_credit_supply),
          payment_status     = CASE
            WHEN outstanding_amount - v_credit_supply <= 0 THEN 'paid'
            WHEN v_credit_supply > 0 THEN 'partial' ELSE payment_status END
      WHERE id = v_new_order_id;
    END IF;
    IF v_old_vat_balance < 0 AND v_inc_vat > 0 THEN
      v_credit_vat := LEAST(ABS(v_old_vat_balance)::BIGINT, v_inc_vat::BIGINT);
      INSERT INTO transactions (tenant_id, customer_id, source, type, method, amount, vat_type, transaction_date, order_id, description)
      VALUES (p_tenant_id, p_customer_id, 'credit_apply', 'income', NULL, v_credit_vat, 'vat', CURRENT_DATE, v_new_order_id, '매입금 자동 충당 (부가세)');
    END IF;
  END IF;

  -- 영수증 박제 (미송 출고 = 확인용 / 보류 출고 = 첫 박제)
  PERFORM issue_receipt_snapshot(v_new_order_id, v_balance_before);

  RETURN v_new_order_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.process_pending_ship(UUID, UUID, UUID[], JSONB, TEXT) TO authenticated;

NOTIFY pgrst, 'reload schema';

COMMIT;
