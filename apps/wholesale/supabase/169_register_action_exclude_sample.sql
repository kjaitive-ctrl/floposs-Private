-- ============================================================
-- 169: process_register_action — 샘플 라인 매출/외상/transactions 박제 제외
--
-- 사장 보고 (2026-05-11):
--   "샘플 처리 자체는 매출/외상을 불러일으키지 않아 — 외상 늘어나면 안 되는데
--    이거 해결했었는데 어디서 다시 생긴거지?"
--
-- 회귀 추적:
--   - 137 (2026-05-06): process_pending_ship 의 hold 분기에 is_sample 제외 추가.
--     "샘플 주문 → [보류] → [당일] 출고 시 판매/외상 박제됨" 사장 보고로 fix 완료.
--   - 163 (2026-05-08, 정공법 재설계): 신규 process_register_action 도입.
--     137 의 학습이 누락 — 신규 RPC 가 is_sample 라인을 일반 매출과 동일 박제.
--   - 결과: 정공법 전환 후 처리화면 [당일]+[처리!] 또는 SaleForm 즉시처리 시
--           샘플 라인이 다시 매출/외상으로 박제됨.
--
-- 사장 정책 (138 마이그에 명문화):
--   - 샘플 출고 = 실물 이동 O, 매출 X, 외상 X, 영수증(샘플 전표) 박제 O
--   - 매출/transactions/outstanding 박제는 v_revenue > 0 일 때만
--   - issue_receipt_snapshot 호출은 항상 (receipt_no 박제 → 샘플 전표 출력 가능)
--
-- 변경 (167 대비):
--   1) v_combined_total 누적 시 is_sample 제외 (line 172-179).
--      qty 합계 (v_shipment_qty/v_combined_qty/v_backorder_qty) 는 그대로 — 영수증 표시용.
--   2) transactions(shipment) INSERT 가드 — v_combined_total > 0 일 때만.
--   3) outstanding_balance UPDATE 가드 — v_combined_total/v_combined_vat_amount > 0 일 때만.
--   4) 매입금 자동 충당 가드 — v_combined_total > 0 일 때만 (LEAST 등 자연 처리되나 명시).
--   5) derived order 의 revenue/confirmed_amount/total_amount = v_combined_total 그대로 (0 박제됨).
--   6) issue_receipt_snapshot 호출은 그대로 — 138 정책 (샘플도 receipt_no 박제) 유지.
--
-- 정합 보존:
--   - 일반 출고 (is_sample=FALSE): 동작 0 변경.
--   - 샘플즉시처리 (모든 라인 is_sample=TRUE):
--       v_combined_total=0 → derived revenue=0, transactions X, outstanding 변동 X.
--       receipt_no 박제 O → 샘플 전표 출력 가능.
--   - 혼합 (샘플 + 일반 라인 동시 출고):
--       v_combined_total = 일반 라인 합계만. 일반 라인 매출/외상만 박제.
--       샘플 라인은 order_items 복사 O, 재고 차감 O, 매출 X.
-- ============================================================

BEGIN;

DROP FUNCTION IF EXISTS public.process_register_action(UUID, UUID, UUID[], JSONB);

CREATE OR REPLACE FUNCTION public.process_register_action(
  p_tenant_id          UUID,
  p_customer_id        UUID,
  p_staging_order_ids  UUID[],
  p_actions            JSONB
) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_action               JSONB;
  v_kind                 TEXT;
  v_items                JSONB;
  v_payload              JSONB;
  v_item                 RECORD;
  v_qty                  INT;
  v_used_qty_by_item     JSONB := '{}'::JSONB;
  v_check_item_id        UUID;
  v_check_qty            INT;
  v_check_used           INT;
  v_kv                   RECORD;
  v_first_staging        RECORD;
  v_first_staging_id     UUID;
  v_orig_vat_in_payment  BOOLEAN;
  v_vat_rate             NUMERIC;
  v_balance_before       NUMERIC;
  v_old_vat_balance      NUMERIC;
  v_combined_total       NUMERIC := 0;   -- 매출 박제용 (is_sample 제외 합계)
  v_combined_qty         INT     := 0;
  v_shipment_qty         INT     := 0;
  v_backorder_qty        INT     := 0;
  v_hold_total           NUMERIC := 0;
  v_hold_qty             INT     := 0;
  v_combined_vat         BIGINT  := 0;
  v_combined_vat_amount  NUMERIC := 0;
  v_combined_order_id    UUID;
  v_hold_order_id        UUID;
  v_combined_order_number TEXT;
  v_hold_order_number    TEXT;
  v_credit_supply        BIGINT;
  v_credit_vat           BIGINT;
  v_inv_qty_after        INT;
  v_has_combined         BOOLEAN := FALSE;
  v_has_hold             BOOLEAN := FALSE;
  v_staging_deleted      UUID[]  := ARRAY[]::UUID[];
  v_staging_id           UUID;
BEGIN
  PERFORM assert_tenant_access(p_tenant_id);

  IF p_actions IS NULL OR jsonb_array_length(p_actions) = 0 THEN
    RAISE EXCEPTION '처리할 액션이 없습니다' USING ERRCODE = 'P0001';
  END IF;
  IF p_staging_order_ids IS NULL OR array_length(p_staging_order_ids, 1) IS NULL THEN
    RAISE EXCEPTION 'staging order ids 가 비어있습니다' USING ERRCODE = 'P0001';
  END IF;

  SELECT id, customer_id, customer_name, payment_method, order_number, order_type, vat_amount, receipt_no
  INTO v_first_staging
  FROM orders
  WHERE id = ANY(p_staging_order_ids)
    AND tenant_id = p_tenant_id
    AND customer_id = p_customer_id
  ORDER BY created_at ASC
  LIMIT 1;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'staging 주문을 찾을 수 없거나 거래처가 다릅니다' USING ERRCODE = 'P0001';
  END IF;
  v_first_staging_id := v_first_staging.id;

  IF EXISTS (
    SELECT 1 FROM orders
    WHERE id = ANY(p_staging_order_ids)
      AND (customer_id <> p_customer_id OR tenant_id <> p_tenant_id OR receipt_no IS NOT NULL)
  ) THEN
    RAISE EXCEPTION 'staging 검증 실패 (다른 거래처 또는 이미 박제된 영수증 포함)' USING ERRCODE = 'P0001';
  END IF;

  v_orig_vat_in_payment := COALESCE(v_first_staging.vat_amount, 0) > 0;
  SELECT COALESCE(vat_rate, 0.10) INTO v_vat_rate FROM tenants WHERE id = p_tenant_id;

  -- 검증 1: 각 item_id 별 사용 qty 합계 ≤ staging.quantity
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
    FROM order_items
    WHERE id = v_check_item_id AND order_id = ANY(p_staging_order_ids);
    IF NOT FOUND THEN
      RAISE EXCEPTION '항목을 찾을 수 없습니다 (% — staging 들 중 어디에도 없음)', v_check_item_id USING ERRCODE='P0001';
    END IF;
    IF v_check_used > v_check_qty THEN
      RAISE EXCEPTION '항목 % 의 처리 합계 (%) 가 주문 수량 (%) 초과', v_check_item_id, v_check_used, v_check_qty USING ERRCODE='P0001';
    END IF;
  END LOOP;

  -- ── kind 별 합계 + 분류 — is_sample 라인은 매출 합계에서 제외 (137/138 정책) ──
  FOR v_action IN SELECT * FROM jsonb_array_elements(p_actions)
  LOOP
    v_kind  := v_action->>'kind';
    v_items := v_action->'items';

    IF v_kind NOT IN ('shipment', 'backorder_register', 'hold_register') THEN
      RAISE EXCEPTION 'kind 는 shipment / backorder_register / hold_register 만 허용 (%)', v_kind USING ERRCODE='P0001';
    END IF;
    IF v_items IS NULL OR jsonb_array_length(v_items) = 0 THEN CONTINUE; END IF;

    FOR v_payload IN SELECT * FROM jsonb_array_elements(v_items)
    LOOP
      v_qty := (v_payload->>'qty')::INT;
      IF v_qty <= 0 THEN CONTINUE; END IF;
      SELECT id, variant_id, unit_price, quantity, is_sample, is_exchange
      INTO v_item FROM order_items
      WHERE id = (v_payload->>'item_id')::UUID AND order_id = ANY(p_staging_order_ids);
      IF NOT FOUND THEN CONTINUE; END IF;

      IF v_kind = 'shipment' THEN
        -- 169: 샘플 라인 매출 박제 제외. qty 는 영수증 표시용 그대로 누적.
        IF NOT COALESCE(v_item.is_sample, FALSE) THEN
          v_combined_total := v_combined_total + (v_qty * v_item.unit_price);
        END IF;
        v_shipment_qty   := v_shipment_qty + v_qty;
        v_combined_qty   := v_combined_qty + v_qty;
      ELSIF v_kind = 'backorder_register' THEN
        IF NOT COALESCE(v_item.is_sample, FALSE) THEN
          v_combined_total := v_combined_total + (v_qty * v_item.unit_price);
        END IF;
        v_backorder_qty  := v_backorder_qty + v_qty;
        v_combined_qty   := v_combined_qty + v_qty;
      ELSIF v_kind = 'hold_register' THEN
        -- 보류는 매출/외상 무관 — 167 그대로
        v_hold_total := v_hold_total + (v_qty * v_item.unit_price);
        v_hold_qty   := v_hold_qty + v_qty;
      END IF;
    END LOOP;
  END LOOP;

  v_has_combined := v_combined_qty > 0;
  v_has_hold     := v_hold_qty > 0;

  IF NOT v_has_combined AND NOT v_has_hold THEN
    RAISE EXCEPTION '처리할 수량이 없습니다' USING ERRCODE = 'P0001';
  END IF;

  SELECT COALESCE(outstanding_balance, 0), COALESCE(outstanding_vat, 0)
  INTO v_balance_before, v_old_vat_balance
  FROM customers WHERE id = p_customer_id;

  -- ── 1) 출고+미송 통합 derived (영수증 박제) ──
  IF v_has_combined THEN
    -- v_combined_total 이 0 (모든 라인 is_sample) 이면 vat 도 자동 0
    v_combined_vat := ROUND(v_combined_total * v_vat_rate)::BIGINT;
    v_combined_vat_amount := CASE WHEN v_orig_vat_in_payment THEN ROUND(v_combined_total * v_vat_rate) ELSE 0 END;

    v_combined_order_number := v_first_staging.order_number || '-CB'
      || substr(replace(gen_random_uuid()::text, '-', ''), 1, 4);

    INSERT INTO orders (
      tenant_id, customer_id, customer_name, order_number, order_type,
      order_source, status, payment_method, payment_status,
      total_amount, vat_amount, paid_amount, outstanding_amount,
      derived_from_order_id, is_processed, has_pending,
      sales_qty, revenue, confirmed_amount, order_qty, memo
    ) VALUES (
      p_tenant_id, p_customer_id, v_first_staging.customer_name, v_combined_order_number,
      COALESCE(v_first_staging.order_type, 'wholesale'),
      'shipment_action', 'shipped', v_first_staging.payment_method, 'unpaid',
      v_combined_total + v_combined_vat_amount, v_combined_vat_amount, 0, v_combined_total,
      v_first_staging_id, TRUE,
      v_backorder_qty > 0,
      v_shipment_qty,
      v_combined_total,
      v_combined_total,
      v_combined_qty,
      '처리 (' || array_length(p_staging_order_ids, 1) || '개 주문)'
    ) RETURNING id INTO v_combined_order_id;

    -- order_items 복사 (shipment + backorder_register 라인) — 샘플 라인 포함 (재고 차감 + 영수증 표시용)
    FOR v_action IN SELECT * FROM jsonb_array_elements(p_actions)
    LOOP
      v_kind  := v_action->>'kind';
      v_items := v_action->'items';
      IF v_kind NOT IN ('shipment', 'backorder_register') THEN CONTINUE; END IF;
      IF v_items IS NULL THEN CONTINUE; END IF;

      FOR v_payload IN SELECT * FROM jsonb_array_elements(v_items)
      LOOP
        v_qty := (v_payload->>'qty')::INT;
        IF v_qty <= 0 THEN CONTINUE; END IF;
        SELECT id, variant_id, unit_price, quantity, is_sample, is_exchange
        INTO v_item FROM order_items
        WHERE id = (v_payload->>'item_id')::UUID AND order_id = ANY(p_staging_order_ids);
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
            v_combined_order_id, v_item.variant_id, v_qty, v_qty, 0,
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
            v_combined_order_id, v_item.variant_id, v_qty, v_qty, v_qty,
            v_item.unit_price, v_qty * v_item.unit_price, 'unshipped', 'backorder',
            0, NULL, v_item.is_sample, v_item.is_exchange
          );
        END IF;
      END LOOP;
    END LOOP;

    -- 169: 매출/외상/transactions 박제는 v_combined_total > 0 일 때만 (샘플만 처리 시 SKIP)
    IF v_combined_total > 0 THEN
      INSERT INTO transactions (tenant_id, customer_id, source, type, method, amount, vat_type, transaction_date, order_id)
      VALUES (p_tenant_id, p_customer_id, 'shipment', 'receivable', v_first_staging.payment_method, v_combined_total, 'supply', CURRENT_DATE, v_combined_order_id);
      IF v_combined_vat > 0 THEN
        INSERT INTO transactions (tenant_id, customer_id, source, type, method, amount, vat_type, transaction_date, order_id)
        VALUES (p_tenant_id, p_customer_id, 'shipment', 'receivable', v_first_staging.payment_method, v_combined_vat, 'vat', CURRENT_DATE, v_combined_order_id);
      END IF;

      UPDATE customers
      SET outstanding_balance = outstanding_balance + v_combined_total,
          outstanding_vat     = outstanding_vat + v_combined_vat
      WHERE id = p_customer_id AND tenant_id = p_tenant_id;

      -- 매입금 자동 충당 (supply / vat 분리) — 매출 박제가 있을 때만
      IF v_balance_before < 0 THEN
        v_credit_supply := LEAST(ABS(v_balance_before)::BIGINT, v_combined_total::BIGINT);
        INSERT INTO transactions (tenant_id, customer_id, source, type, method, amount, vat_type, transaction_date, order_id, description)
        VALUES (p_tenant_id, p_customer_id, 'credit_apply', 'income', NULL, v_credit_supply, 'supply', CURRENT_DATE, v_combined_order_id, '매입금 자동 충당 (공급가)');

        UPDATE orders
        SET paid_amount        = COALESCE(paid_amount, 0) + v_credit_supply,
            outstanding_amount = GREATEST(0, outstanding_amount - v_credit_supply),
            payment_status     = CASE
              WHEN GREATEST(0, outstanding_amount - v_credit_supply) = 0 THEN 'paid'
              WHEN v_credit_supply > 0 THEN 'partial' ELSE payment_status END
        WHERE id = v_combined_order_id;
      END IF;
      IF v_old_vat_balance < 0 AND v_combined_vat > 0 THEN
        v_credit_vat := LEAST(ABS(v_old_vat_balance)::BIGINT, v_combined_vat::BIGINT);
        INSERT INTO transactions (tenant_id, customer_id, source, type, method, amount, vat_type, transaction_date, order_id, description)
        VALUES (p_tenant_id, p_customer_id, 'credit_apply', 'income', NULL, v_credit_vat, 'vat', CURRENT_DATE, v_combined_order_id, '매입금 자동 충당 (부가세)');
      END IF;
    END IF;

    -- 영수증 박제 (138 정책): 샘플도 receipt_no 박제. 출력 시 API 자동 분기로 샘플 전표.
    PERFORM issue_receipt_snapshot(v_combined_order_id, v_balance_before);
  END IF;

  -- ── 2) 보류 derived (영수증/매출/외상 X) — 167 그대로 ──
  IF v_has_hold THEN
    v_hold_order_number := v_first_staging.order_number || '-HR'
      || substr(replace(gen_random_uuid()::text, '-', ''), 1, 4);

    INSERT INTO orders (
      tenant_id, customer_id, customer_name, order_number, order_type,
      order_source, status, payment_method, payment_status,
      total_amount, vat_amount, paid_amount, outstanding_amount,
      derived_from_order_id, is_processed, has_pending,
      sales_qty, revenue, confirmed_amount, order_qty, memo
    ) VALUES (
      p_tenant_id, p_customer_id, v_first_staging.customer_name, v_hold_order_number,
      COALESCE(v_first_staging.order_type, 'wholesale'),
      'hold_register', 'shipped', v_first_staging.payment_method, 'paid',
      v_hold_total, 0, 0, 0,
      v_first_staging_id, TRUE, TRUE,
      0,
      0,
      v_hold_total,
      v_hold_qty,
      '보류 등록 (' || v_hold_qty || '개)'
    ) RETURNING id INTO v_hold_order_id;

    FOR v_action IN SELECT * FROM jsonb_array_elements(p_actions)
    LOOP
      v_kind := v_action->>'kind';
      IF v_kind <> 'hold_register' THEN CONTINUE; END IF;
      v_items := v_action->'items';
      IF v_items IS NULL THEN CONTINUE; END IF;

      FOR v_payload IN SELECT * FROM jsonb_array_elements(v_items)
      LOOP
        v_qty := (v_payload->>'qty')::INT;
        IF v_qty <= 0 THEN CONTINUE; END IF;
        SELECT id, variant_id, unit_price, quantity, is_sample, is_exchange
        INTO v_item FROM order_items
        WHERE id = (v_payload->>'item_id')::UUID AND order_id = ANY(p_staging_order_ids);
        IF NOT FOUND THEN CONTINUE; END IF;

        INSERT INTO order_items (
          order_id, variant_id, quantity, original_quantity, remaining_qty,
          unit_price, total_price, status, process_type,
          shipped_qty, shipped_at, is_sample, is_exchange
        ) VALUES (
          v_hold_order_id, v_item.variant_id, v_qty, v_qty, v_qty,
          v_item.unit_price, v_qty * v_item.unit_price, 'unshipped', 'hold',
          0, NULL, v_item.is_sample, v_item.is_exchange
        );
      END LOOP;
    END LOOP;
  END IF;

  -- ── 3) 명시된 item_id 폐기 + 빈 staging 삭제 ──
  DELETE FROM order_items
  WHERE order_id = ANY(p_staging_order_ids)
    AND id IN (SELECT (key)::UUID FROM jsonb_each_text(v_used_qty_by_item));

  FOREACH v_staging_id IN ARRAY p_staging_order_ids
  LOOP
    IF NOT EXISTS (SELECT 1 FROM order_items WHERE order_id = v_staging_id) THEN
      DELETE FROM orders WHERE id = v_staging_id;
      v_staging_deleted := array_append(v_staging_deleted, v_staging_id);
    END IF;
  END LOOP;

  RETURN json_build_object(
    'success', true,
    'combined_order_id', v_combined_order_id,
    'hold_order_id',     v_hold_order_id,
    'staging_deleted',   to_jsonb(v_staging_deleted)
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.process_register_action(UUID, UUID, UUID[], JSONB) TO authenticated;

NOTIFY pgrst, 'reload schema';

COMMIT;
