-- ============================================================
-- 165: process_register_action 잔여 폐기 범위 수정 (2026-05-08 사장 보고)
--
-- 버그:
--   2개 주문 (각 2장) = 4 items 등록. 1장만 [출고] 토글 + 처리 →
--   토글 안 된 같은 staging 의 다른 row 까지 모두 사라짐.
--   사장 의도: "아무것도 손대지 않은 미처리 건은 미처리 상태로 둬야해"
--
-- 원인:
--   163 의 process_register_action 마지막:
--     DELETE FROM order_items WHERE order_id = p_staging_order_id;
--   = staging 의 모든 items 폐기 (토글 안 된 잔여까지).
--
-- 수정:
--   actions 에 명시된 item_id 만 폐기 (토글된 row + 그 row 의 부분처리 잔여).
--   토글 안 된 row 는 staging 에 그대로 남음.
--   staging 의 남은 items 가 0 일 때만 staging order DELETE.
--
-- 잔여 폐기 정의 재정리:
--   - 토글 + qty<quantity 부분처리 → 그 row 폐기 (잔여 자동 폐기, 사장 결정 그대로)
--   - 토글 + qty>=quantity 전량 → 그 row 폐기
--   - 출고+미송 split 토글 → 한 row 가 두 actions, 합계 = quantity → row 폐기
--   - 토글 안 됨 → row 그대로 (staging 살림)
-- ============================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.process_register_action(
  p_tenant_id        UUID,
  p_staging_order_id UUID,
  p_actions          JSONB
) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_staging              RECORD;
  v_action               JSONB;
  v_kind                 TEXT;
  v_items                JSONB;
  v_payload              JSONB;
  v_item                 RECORD;
  v_qty                  INT;
  v_total                NUMERIC;
  v_total_qty            INT;
  v_inc_vat              BIGINT;
  v_new_vat_amount       NUMERIC;
  v_new_order_id         UUID;
  v_new_order_number     TEXT;
  v_suffix               TEXT;
  v_initial_outstanding  NUMERIC;
  v_payment_status       TEXT;
  v_balance_before       NUMERIC;
  v_old_vat_balance      NUMERIC;
  v_credit_supply        BIGINT;
  v_credit_vat           BIGINT;
  v_vat_rate             NUMERIC;
  v_orig_vat_in_payment  BOOLEAN;
  v_inv_qty_after        INT;
  v_used_qty_by_item     JSONB := '{}'::JSONB;
  v_check_item_id        UUID;
  v_check_qty            INT;
  v_check_used           INT;
  v_derived_ids          UUID[] := ARRAY[]::UUID[];
  v_kv                   RECORD;
  v_staging_deleted      BOOLEAN := FALSE;
BEGIN
  PERFORM assert_tenant_access(p_tenant_id);

  IF p_actions IS NULL OR jsonb_array_length(p_actions) = 0 THEN
    RAISE EXCEPTION '처리할 액션이 없습니다' USING ERRCODE = 'P0001';
  END IF;

  SELECT id, customer_id, customer_name, payment_method, order_number, order_type, vat_amount, receipt_no
  INTO v_staging
  FROM orders WHERE id = p_staging_order_id AND tenant_id = p_tenant_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'staging 주문을 찾을 수 없습니다 (%)', p_staging_order_id USING ERRCODE='P0001';
  END IF;
  IF v_staging.receipt_no IS NOT NULL THEN
    RAISE EXCEPTION '이미 영수증이 박제된 주문은 처리 불가 (%)', v_staging.receipt_no USING ERRCODE='P0001';
  END IF;
  v_orig_vat_in_payment := COALESCE(v_staging.vat_amount, 0) > 0;

  SELECT COALESCE(vat_rate, 0.10) INTO v_vat_rate FROM tenants WHERE id = p_tenant_id;

  -- 검증: 각 item_id 별 사용 qty 합계 ≤ staging.quantity
  FOR v_action IN SELECT * FROM jsonb_array_elements(p_actions)
  LOOP
    v_items := v_action->'items';
    IF v_items IS NULL THEN CONTINUE; END IF;
    FOR v_payload IN SELECT * FROM jsonb_array_elements(v_items)
    LOOP
      v_check_item_id := (v_payload->>'item_id')::UUID;
      v_check_qty     := (v_payload->>'qty')::INT;
      IF v_check_qty <= 0 THEN CONTINUE; END IF;
      v_check_used := COALESCE((v_used_qty_by_item->>(v_check_item_id::TEXT))::INT, 0);
      v_used_qty_by_item := jsonb_set(v_used_qty_by_item, ARRAY[v_check_item_id::TEXT], to_jsonb(v_check_used + v_check_qty));
    END LOOP;
  END LOOP;
  FOR v_kv IN SELECT key, value FROM jsonb_each_text(v_used_qty_by_item)
  LOOP
    v_check_item_id := v_kv.key::UUID;
    v_check_used    := v_kv.value::INT;
    SELECT quantity INTO v_check_qty
    FROM order_items WHERE id = v_check_item_id AND order_id = p_staging_order_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION '항목을 찾을 수 없습니다 (%)', v_check_item_id USING ERRCODE='P0001';
    END IF;
    IF v_check_used > v_check_qty THEN
      RAISE EXCEPTION '항목 % 의 처리 합계 (%) 가 주문 수량 (%) 초과', v_check_item_id, v_check_used, v_check_qty USING ERRCODE='P0001';
    END IF;
  END LOOP;

  -- 액션별 처리 (163 그대로)
  FOR v_action IN SELECT * FROM jsonb_array_elements(p_actions)
  LOOP
    v_kind  := v_action->>'kind';
    v_items := v_action->'items';

    IF v_kind NOT IN ('shipment', 'backorder_register', 'hold_register') THEN
      RAISE EXCEPTION 'kind 는 shipment / backorder_register / hold_register 만 허용 (%)', v_kind USING ERRCODE='P0001';
    END IF;
    IF v_items IS NULL OR jsonb_array_length(v_items) = 0 THEN CONTINUE; END IF;

    v_total := 0;
    v_total_qty := 0;
    FOR v_payload IN SELECT * FROM jsonb_array_elements(v_items)
    LOOP
      v_qty := (v_payload->>'qty')::INT;
      IF v_qty <= 0 THEN CONTINUE; END IF;
      SELECT id, variant_id, unit_price, quantity, is_sample, is_exchange
      INTO v_item FROM order_items
      WHERE id = (v_payload->>'item_id')::UUID AND order_id = p_staging_order_id;
      IF NOT FOUND THEN CONTINUE; END IF;
      v_total := v_total + (v_qty * v_item.unit_price);
      v_total_qty := v_total_qty + v_qty;
    END LOOP;
    IF v_total_qty <= 0 THEN CONTINUE; END IF;

    v_suffix := CASE v_kind
      WHEN 'shipment'           THEN 'SH'
      WHEN 'backorder_register' THEN 'BR'
      WHEN 'hold_register'      THEN 'HR'
    END;

    IF v_kind IN ('shipment', 'backorder_register') THEN
      v_inc_vat := ROUND(v_total * v_vat_rate)::BIGINT;
      v_new_vat_amount := CASE WHEN v_orig_vat_in_payment THEN ROUND(v_total * v_vat_rate) ELSE 0 END;
      v_initial_outstanding := v_total;
      v_payment_status := 'unpaid';
    ELSE
      v_inc_vat := 0;
      v_new_vat_amount := 0;
      v_initial_outstanding := 0;
      v_payment_status := 'paid';
    END IF;

    SELECT COALESCE(outstanding_balance, 0), COALESCE(outstanding_vat, 0)
    INTO v_balance_before, v_old_vat_balance
    FROM customers WHERE id = v_staging.customer_id;

    v_new_order_number := v_staging.order_number || '-' || v_suffix
      || substr(replace(gen_random_uuid()::text, '-', ''), 1, 4);

    INSERT INTO orders (
      tenant_id, customer_id, customer_name, order_number, order_type,
      order_source, status, payment_method, payment_status,
      total_amount, vat_amount, paid_amount, outstanding_amount,
      derived_from_order_id, is_processed, has_pending,
      sales_qty, revenue, confirmed_amount, order_qty, memo
    ) VALUES (
      p_tenant_id, v_staging.customer_id, v_staging.customer_name, v_new_order_number,
      COALESCE(v_staging.order_type, 'wholesale'),
      v_kind, 'shipped', v_staging.payment_method, v_payment_status,
      v_total + v_new_vat_amount, v_new_vat_amount, 0, v_initial_outstanding,
      p_staging_order_id, TRUE,
      v_kind <> 'shipment',
      CASE WHEN v_kind = 'shipment' THEN v_total_qty ELSE 0 END,
      CASE WHEN v_kind IN ('shipment', 'backorder_register') THEN v_total ELSE 0 END,
      v_total,
      v_total_qty,
      CASE v_kind
        WHEN 'shipment'           THEN '출고 (원본: ' || v_staging.order_number || ')'
        WHEN 'backorder_register' THEN '미송 등록 (원본: ' || v_staging.order_number || ')'
        WHEN 'hold_register'      THEN '보류 등록 (원본: ' || v_staging.order_number || ')'
      END
    ) RETURNING id INTO v_new_order_id;

    FOR v_payload IN SELECT * FROM jsonb_array_elements(v_items)
    LOOP
      v_qty := (v_payload->>'qty')::INT;
      IF v_qty <= 0 THEN CONTINUE; END IF;
      SELECT id, variant_id, unit_price, quantity, is_sample, is_exchange
      INTO v_item FROM order_items
      WHERE id = (v_payload->>'item_id')::UUID AND order_id = p_staging_order_id;
      IF NOT FOUND THEN CONTINUE; END IF;

      IF v_kind = 'shipment' THEN
        SELECT quantity INTO v_inv_qty_after FROM inventory
        WHERE tenant_id = p_tenant_id AND variant_id = v_item.variant_id FOR UPDATE;
        IF v_inv_qty_after IS NULL OR v_inv_qty_after < v_qty THEN
          RAISE EXCEPTION '재고 부족 (variant: %, 현재 %, 필요 %)',
            v_item.variant_id, COALESCE(v_inv_qty_after, 0), v_qty USING ERRCODE='P0001';
        END IF;
        UPDATE inventory SET quantity = quantity - v_qty, updated_at = NOW()
        WHERE tenant_id = p_tenant_id AND variant_id = v_item.variant_id
        RETURNING quantity INTO v_inv_qty_after;

        INSERT INTO order_items (
          order_id, variant_id, quantity, original_quantity, remaining_qty,
          unit_price, total_price, status, process_type,
          shipped_qty, shipped_at, is_sample, is_exchange
        ) VALUES (
          v_new_order_id, v_item.variant_id, v_qty, v_qty, 0,
          v_item.unit_price, v_qty * v_item.unit_price, 'shipped', 'ordered',
          v_qty, NOW(), v_item.is_sample, v_item.is_exchange
        );

        INSERT INTO inventory_logs (tenant_id, variant_id, order_item_id, qty_change, balance_after, reason, process_type)
        VALUES (p_tenant_id, v_item.variant_id, NULL, -v_qty, COALESCE(v_inv_qty_after, 0), 'shipment', 'ordered');

      ELSIF v_kind = 'backorder_register' THEN
        INSERT INTO order_items (
          order_id, variant_id, quantity, original_quantity, remaining_qty,
          unit_price, total_price, status, process_type,
          shipped_qty, shipped_at, is_sample, is_exchange
        ) VALUES (
          v_new_order_id, v_item.variant_id, v_qty, v_qty, v_qty,
          v_item.unit_price, v_qty * v_item.unit_price, 'unshipped', 'backorder',
          0, NULL, v_item.is_sample, v_item.is_exchange
        );

      ELSIF v_kind = 'hold_register' THEN
        INSERT INTO order_items (
          order_id, variant_id, quantity, original_quantity, remaining_qty,
          unit_price, total_price, status, process_type,
          shipped_qty, shipped_at, is_sample, is_exchange
        ) VALUES (
          v_new_order_id, v_item.variant_id, v_qty, v_qty, v_qty,
          v_item.unit_price, v_qty * v_item.unit_price, 'unshipped', 'hold',
          0, NULL, v_item.is_sample, v_item.is_exchange
        );
      END IF;
    END LOOP;

    IF v_kind IN ('shipment', 'backorder_register') THEN
      INSERT INTO transactions (tenant_id, customer_id, source, type, method, amount, vat_type, transaction_date, order_id)
      VALUES (p_tenant_id, v_staging.customer_id, 'shipment', 'receivable', v_staging.payment_method, v_total, 'supply', CURRENT_DATE, v_new_order_id);
      IF v_inc_vat > 0 THEN
        INSERT INTO transactions (tenant_id, customer_id, source, type, method, amount, vat_type, transaction_date, order_id)
        VALUES (p_tenant_id, v_staging.customer_id, 'shipment', 'receivable', v_staging.payment_method, v_inc_vat, 'vat', CURRENT_DATE, v_new_order_id);
      END IF;

      UPDATE customers
      SET outstanding_balance = outstanding_balance + v_total,
          outstanding_vat     = outstanding_vat + v_inc_vat
      WHERE id = v_staging.customer_id AND tenant_id = p_tenant_id;

      IF v_balance_before < 0 THEN
        v_credit_supply := LEAST(ABS(v_balance_before)::BIGINT, v_total::BIGINT);
        INSERT INTO transactions (tenant_id, customer_id, source, type, method, amount, vat_type, transaction_date, order_id, description)
        VALUES (p_tenant_id, v_staging.customer_id, 'credit_apply', 'income', NULL, v_credit_supply, 'supply', CURRENT_DATE, v_new_order_id, '매입금 자동 충당 (공급가)');

        UPDATE orders
        SET paid_amount        = COALESCE(paid_amount, 0) + v_credit_supply,
            outstanding_amount = GREATEST(0, outstanding_amount - v_credit_supply),
            payment_status     = CASE
              WHEN GREATEST(0, outstanding_amount - v_credit_supply) = 0 THEN 'paid'
              WHEN v_credit_supply > 0 THEN 'partial' ELSE payment_status END
        WHERE id = v_new_order_id;
      END IF;
      IF v_old_vat_balance < 0 AND v_inc_vat > 0 THEN
        v_credit_vat := LEAST(ABS(v_old_vat_balance)::BIGINT, v_inc_vat::BIGINT);
        INSERT INTO transactions (tenant_id, customer_id, source, type, method, amount, vat_type, transaction_date, order_id, description)
        VALUES (p_tenant_id, v_staging.customer_id, 'credit_apply', 'income', NULL, v_credit_vat, 'vat', CURRENT_DATE, v_new_order_id, '매입금 자동 충당 (부가세)');
      END IF;

      PERFORM issue_receipt_snapshot(v_new_order_id, v_balance_before);
    END IF;

    v_derived_ids := array_append(v_derived_ids, v_new_order_id);
  END LOOP;

  -- ── 165 핵심 변경: 명시된 item_id 만 폐기. 토글 안 된 row 는 staging 에 살림 ──
  DELETE FROM order_items
  WHERE order_id = p_staging_order_id
    AND id IN (SELECT (key)::UUID FROM jsonb_each_text(v_used_qty_by_item));

  IF NOT EXISTS (SELECT 1 FROM order_items WHERE order_id = p_staging_order_id) THEN
    DELETE FROM orders WHERE id = p_staging_order_id;
    v_staging_deleted := TRUE;
  END IF;

  RETURN json_build_object(
    'success', true,
    'derived_order_ids', to_jsonb(v_derived_ids),
    'staging_deleted', v_staging_deleted
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.process_register_action(UUID, UUID, JSONB) TO authenticated;

NOTIFY pgrst, 'reload schema';

COMMIT;
