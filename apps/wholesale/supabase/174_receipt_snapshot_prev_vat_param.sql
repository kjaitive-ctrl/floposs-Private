-- ============================================================
-- 174: 영수증 박제 시점 일치 + 반품/해제 vat 박제 분리 (정공법 매트릭스 완성)
--
-- 사장 보고 (2026-05-12):
--   1) "부가세 2,000원이 전잔에 생기는거같아 (새 거래처 첫 거래에도)"
--   2) "외상매입이 -일때 전잔에 vat 가 - 로 안되는거야 (반품 후 매입금 보유 거래처)"
--
-- 원인 (162 마이그 미완성):
--   A) issue_receipt_snapshot 시그니처 — supply 는 인자, vat 는 함수 안 SELECT
--      → 두 값 시점 어긋남 (supply=처리전, vat=처리후)
--      → 영수증 전잔/당잔에 이번 거래 vat 가 누적 박제됨
--   B) 161/162 정공법 매트릭스 "shipment 류는 vat 행 항상 INSERT" 선언했으나
--      반품/해제 RPC 가 빠짐 — transactions(return) 박제 시 vat_type='supply' 만,
--      vat_type='vat' 박제 누락 → vat 외상 ledger 어긋남
--
-- 사장 모델 (정공법):
--   "처리 시점에 supply, vat 외상 모두 캡쳐 후 인자 전달. 정공법 매트릭스 통일."
--
-- Fix:
--   A) issue_receipt_snapshot 시그니처에 p_prev_vat_balance 인자 추가.
--      함수 안 SELECT outstanding_vat 제거.
--   B) process_return_derived / process_release_for_customer:
--      원 영수증 vat 비례 산출 → transactions(vat_type='vat') 박제 + customers.outstanding_vat -=
--   C) 모든 호출자 (5개 RPC) 에서 처리 직전 v_old_vat_balance 캡쳐 + 인자 전달
--
-- 영향 호출자:
--   1. process_register_action (170)            — v_old_vat_balance 이미 캡쳐됨, 호출만 변경
--   2. process_pending_ship (168)               — v_old_vat_balance 이미 캡쳐됨, 호출만 변경
--   3. process_release_for_customer (148)       — v_old_vat_balance + vat 박제 분리 추가
--   4. process_return_derived (141)             — v_old_vat_balance + vat 박제 분리 추가
--   5. convert_samples_bulk (136)               — v_old_vat_balance 캡쳐 추가
--
-- Backfill: 안 함 (사장 결정 2026-05-12 — 서버 리셋 예정)
-- ============================================================

BEGIN;

-- ── 1) issue_receipt_snapshot — 시그니처 변경 (p_prev_vat_balance 추가) ──
DROP FUNCTION IF EXISTS issue_receipt_snapshot(UUID, NUMERIC);

CREATE OR REPLACE FUNCTION issue_receipt_snapshot(
  p_order_id         UUID,
  p_prev_balance     NUMERIC,
  p_prev_vat_balance NUMERIC DEFAULT 0
)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_order              RECORD;
  v_payment_method     TEXT;
  v_receipt_no         TEXT;
  v_seq                INT;
  v_vat_rate           NUMERIC;
  v_supply             NUMERIC;
  v_vat                NUMERIC;
  v_total              NUMERIC;
  v_vat_in_payment     BOOLEAN;
  v_payment_amount     NUMERIC;
  v_prev_balance_disp  NUMERIC;
  v_post_balance       NUMERIC;
  v_day_total          NUMERIC;
  v_orig_supply        NUMERIC;
  v_orig_vat           NUMERIC;
BEGIN
  SELECT id, tenant_id, customer_id, total_amount, vat_amount, payment_method, receipt_no,
         derived_from_order_id, revenue, order_source
  INTO v_order FROM orders WHERE id = p_order_id;

  IF NOT FOUND THEN RETURN; END IF;
  IF v_order.receipt_no IS NOT NULL THEN RETURN; END IF;

  SELECT default_payment_method INTO v_payment_method
  FROM customers WHERE id = v_order.customer_id;
  v_payment_method := COALESCE(v_payment_method, v_order.payment_method, 'cash');

  SELECT COALESCE(vat_rate, 0.10) INTO v_vat_rate
  FROM tenants WHERE id = v_order.tenant_id;

  -- supply 박제: derived 면 revenue, 일반이면 (total - vat)
  IF v_order.derived_from_order_id IS NOT NULL THEN
    v_supply := COALESCE(v_order.revenue, 0);
  ELSE
    v_supply := COALESCE(v_order.total_amount, 0) - COALESCE(v_order.vat_amount, 0);
  END IF;

  -- 172 fix 유지: vat_in_payment + vat 박제
  -- 반품/해제 derived: 원영수증 vat_in_payment 상속 + vat 비례 계산
  -- 그 외 모든 주문: derived.vat_amount > 0 으로 판단
  IF v_order.derived_from_order_id IS NOT NULL
     AND v_order.order_source IN ('return', 'backorder_release') THEN
    SELECT COALESCE(receipt_vat_in_payment, false),
           COALESCE(receipt_supply_amount, 0),
           COALESCE(receipt_vat_amount, 0)
    INTO v_vat_in_payment, v_orig_supply, v_orig_vat
    FROM orders WHERE id = v_order.derived_from_order_id;

    IF v_orig_supply <> 0 THEN
      v_vat := ROUND(v_supply * v_orig_vat / v_orig_supply);
    ELSE
      v_vat := ROUND(v_supply * v_vat_rate);
    END IF;
  ELSE
    v_vat_in_payment := COALESCE(v_order.vat_amount, 0) > 0;
    v_vat := ROUND(v_supply * v_vat_rate);
  END IF;

  v_total := v_supply + v_vat;

  -- 174: 결제액 SUM 에서 credit_apply 제외 (173 customer sync 와 일관)
  -- credit_apply 는 audit only — customer 외상 영향 X, 영수증 post 도 customer 와 일치해야 정합.
  -- payment 만 SUM → post_balance = customer.outstanding_balance + outstanding_vat 와 자동 정합.
  IF v_vat_in_payment THEN
    SELECT COALESCE(SUM(amount), 0) INTO v_payment_amount
    FROM transactions
    WHERE order_id = p_order_id AND source = 'payment';
  ELSE
    SELECT COALESCE(SUM(amount), 0) INTO v_payment_amount
    FROM transactions
    WHERE order_id = p_order_id AND source = 'payment' AND vat_type = 'supply';
  END IF;

  -- ── 174 fix: prev_balance_disp = 처리 직전 supply + 처리 직전 vat (인자 모두 사용) ──
  -- 162 SELECT outstanding_vat 제거. 호출자가 처리 직전 시점 값 인자로 전달.
  v_prev_balance_disp := CASE
    WHEN v_vat_in_payment THEN p_prev_balance + p_prev_vat_balance
    ELSE p_prev_balance
  END;

  v_day_total := CASE WHEN v_vat_in_payment THEN v_total ELSE v_supply END;
  v_post_balance := v_prev_balance_disp + v_day_total - v_payment_amount;

  SELECT COUNT(*) + 1 INTO v_seq
  FROM orders
  WHERE tenant_id = v_order.tenant_id
    AND receipt_issued_at IS NOT NULL
    AND receipt_issued_at::DATE = CURRENT_DATE;
  v_receipt_no := 'R' || to_char(NOW(), 'YYYYMMDD') || '-' || LPAD(v_seq::text, 4, '0');

  UPDATE orders SET
    receipt_no              = v_receipt_no,
    receipt_issued_at       = NOW(),
    receipt_supply_amount   = v_supply,
    receipt_vat_amount      = v_vat,
    receipt_total_amount    = v_total,
    receipt_vat_in_payment  = v_vat_in_payment,
    receipt_prev_balance    = v_prev_balance_disp,
    receipt_day_total       = v_day_total,
    receipt_payment_method  = v_payment_method,
    receipt_payment_amount  = v_payment_amount,
    receipt_post_balance    = v_post_balance
  WHERE id = p_order_id;
END;
$$;


-- ── 2) process_register_action — 호출 시 v_old_vat_balance 전달 (170 본문 그대로) ──
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
  v_combined_total       NUMERIC := 0;
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

  IF v_has_combined THEN
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
            shipped_qty, shipped_at, is_sample, is_exchange, sample_status
          ) VALUES (
            v_combined_order_id, v_item.variant_id, v_qty, v_qty, 0,
            v_item.unit_price, v_qty * v_item.unit_price, 'shipped', 'ordered',
            v_qty, NOW(), v_item.is_sample, v_item.is_exchange,
            CASE WHEN v_item.is_sample THEN 'pending' ELSE NULL END
          );

          INSERT INTO inventory_logs (tenant_id, variant_id, order_item_id, qty_change, balance_after, reason, process_type)
          VALUES (p_tenant_id, v_item.variant_id, NULL, -v_qty, COALESCE(v_inv_qty_after, 0), 'shipment', 'ordered');

        ELSIF v_kind = 'backorder_register' THEN
          INSERT INTO order_items (
            order_id, variant_id, quantity, original_quantity, remaining_qty,
            unit_price, total_price, status, process_type,
            shipped_qty, shipped_at, is_sample, is_exchange, sample_status
          ) VALUES (
            v_combined_order_id, v_item.variant_id, v_qty, v_qty, v_qty,
            v_item.unit_price, v_qty * v_item.unit_price, 'unshipped', 'backorder',
            0, NULL, v_item.is_sample, v_item.is_exchange,
            CASE WHEN v_item.is_sample THEN 'pending' ELSE NULL END
          );
        END IF;
      END LOOP;
    END LOOP;

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

    -- 174 fix: 처리 전 vat 외상 전달
    PERFORM issue_receipt_snapshot(v_combined_order_id, v_balance_before, v_old_vat_balance);
  END IF;

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
      0, 0, v_hold_total, v_hold_qty,
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
          shipped_qty, shipped_at, is_sample, is_exchange, sample_status
        ) VALUES (
          v_hold_order_id, v_item.variant_id, v_qty, v_qty, v_qty,
          v_item.unit_price, v_qty * v_item.unit_price, 'unshipped', 'hold',
          0, NULL, v_item.is_sample, v_item.is_exchange,
          CASE WHEN v_item.is_sample THEN 'pending' ELSE NULL END
        );
      END LOOP;
    END LOOP;
  END IF;

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


-- ── 3) process_pending_ship — 호출 시 v_old_vat_balance 전달 (168 본문 그대로) ──
DROP FUNCTION IF EXISTS public.process_pending_ship(UUID, UUID, UUID[], JSONB, TEXT);

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

  -- 174 fix: 처리 전 vat 외상 전달
  PERFORM issue_receipt_snapshot(v_new_order_id, v_balance_before, v_old_vat_balance);

  RETURN v_new_order_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.process_pending_ship(UUID, UUID, UUID[], JSONB, TEXT) TO authenticated;


-- ── 4) process_release_for_customer — v_old_vat_balance 캡쳐 추가 + 호출 변경 (166 본문 베이스) ──
-- 166: source='return' / 양수 박제 + outstanding_vat -= v_neg_vat (vat 박제 분리 완성)
-- 174: v_old_vat_balance 캡쳐 + issue_receipt_snapshot 호출 시 인자 전달
DROP FUNCTION IF EXISTS process_release_for_customer(UUID, UUID, JSONB);

CREATE OR REPLACE FUNCTION process_release_for_customer(
  p_tenant_id UUID, p_customer_id UUID, p_items JSONB
) RETURNS JSON LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_orig                RECORD;
  v_new_order_id        UUID;
  v_new_order_number    TEXT;
  v_total_amount        NUMERIC := 0;
  v_total_qty           INT     := 0;
  v_balance_before      NUMERIC;
  v_old_vat_balance     NUMERIC;
  v_payload             JSONB;
  v_item_id             UUID;
  v_qty                 INT;
  v_item                RECORD;
  v_first_order_id      UUID;
  v_clamped             JSONB := '[]'::JSONB;
  v_vat_rate            NUMERIC;
  v_orig_vat            NUMERIC;
  v_orig_vat_in_payment BOOLEAN;
  v_neg_vat             BIGINT := 0;
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

  -- 174 fix: vat 외상도 캡쳐 (영수증 박제 시점 일치용)
  SELECT COALESCE(outstanding_balance, 0), COALESCE(outstanding_vat, 0)
  INTO v_balance_before, v_old_vat_balance
  FROM customers WHERE id = p_customer_id;

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

  -- 166: source='return' / 양수 (process_return_derived 와 동일 패턴) + vat 박제 분리
  INSERT INTO transactions (tenant_id, customer_id, source, type, method, amount, vat_type, transaction_date, order_id, description)
  VALUES (p_tenant_id, p_customer_id, 'return', 'income', v_orig.payment_method, v_total_amount, 'supply', CURRENT_DATE, v_new_order_id, '미송해제');
  IF v_orig_vat_in_payment AND v_neg_vat > 0 THEN
    INSERT INTO transactions (tenant_id, customer_id, source, type, method, amount, vat_type, transaction_date, order_id, description)
    VALUES (p_tenant_id, p_customer_id, 'return', 'income', v_orig.payment_method, v_neg_vat, 'vat', CURRENT_DATE, v_new_order_id, '미송해제');
  END IF;

  UPDATE customers
  SET outstanding_balance = outstanding_balance - v_total_amount,
      outstanding_vat     = outstanding_vat - CASE WHEN v_orig_vat_in_payment THEN v_neg_vat ELSE 0 END
  WHERE id = p_customer_id AND tenant_id = p_tenant_id;

  -- 174 fix: 처리 전 vat 외상 전달
  PERFORM issue_receipt_snapshot(v_new_order_id, v_balance_before, v_old_vat_balance);

  RETURN json_build_object(
    'success', true, 'new_order_id', v_new_order_id, 'new_order_number', v_new_order_number,
    'amount', -v_total_amount, 'count', v_total_qty
  );
END;
$$;

GRANT EXECUTE ON FUNCTION process_release_for_customer(UUID, UUID, JSONB) TO authenticated;


-- ── 5) process_return_derived — v_old_vat_balance 캡쳐 추가 + 호출 변경 (141 본문 베이스) ──
DROP FUNCTION IF EXISTS process_return_derived(UUID, UUID, JSONB, TEXT);

CREATE OR REPLACE FUNCTION process_return_derived(
  p_tenant_id  UUID,
  p_order_id   UUID,
  p_items      JSONB,
  p_reason     TEXT DEFAULT 'return'
) RETURNS JSON LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_orig                RECORD;
  v_new_order_id        UUID;
  v_new_order_number    TEXT;
  v_total               NUMERIC := 0;
  v_qty                 INT     := 0;
  v_return_vat          NUMERIC := 0;
  v_balance_before      NUMERIC;
  v_old_vat_balance     NUMERIC;
  v_payload             JSONB;
  v_item_id             UUID;
  v_qty_to_return       INT;
  v_item                RECORD;
  v_inv_qty             INT;
  v_label               TEXT;
  v_already_returned    INT;
  v_returnable          INT;
  v_orig_supply         NUMERIC;
  v_orig_vat            NUMERIC;
  v_orig_vat_in_payment BOOLEAN;
BEGIN
  PERFORM assert_tenant_access(p_tenant_id);

  IF p_items IS NULL OR jsonb_array_length(p_items) = 0 THEN
    RETURN json_build_object('success', false, 'error', '항목이 비어있습니다.');
  END IF;

  IF p_reason NOT IN ('return', 'exchange') THEN
    RETURN json_build_object('success', false, 'error', 'p_reason 은 return 또는 exchange 만 허용');
  END IF;

  v_label := CASE p_reason WHEN 'exchange' THEN '교환반품' ELSE '반품' END;

  -- 174: 원영수증 vat 비례 박제용 메타 함께 SELECT
  SELECT customer_id, customer_name, payment_method, order_number, order_type,
         COALESCE(receipt_supply_amount, 0)     AS r_supply,
         COALESCE(receipt_vat_amount, 0)        AS r_vat,
         COALESCE(receipt_vat_in_payment, false) AS r_vat_in_payment
  INTO v_orig
  FROM orders WHERE id = p_order_id AND tenant_id = p_tenant_id;

  IF NOT FOUND THEN
    RETURN json_build_object('success', false, 'error', '원 주문을 찾을 수 없습니다.');
  END IF;

  v_orig_supply         := v_orig.r_supply;
  v_orig_vat            := v_orig.r_vat;
  v_orig_vat_in_payment := v_orig.r_vat_in_payment;

  -- 174 fix: vat 외상도 캡쳐
  SELECT COALESCE(outstanding_balance, 0), COALESCE(outstanding_vat, 0)
  INTO v_balance_before, v_old_vat_balance
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

    SELECT COALESCE(SUM(qty_change), 0) INTO v_already_returned
    FROM inventory_logs
    WHERE order_item_id = v_item_id AND reason IN ('return', 'exchange');

    v_returnable := v_item.shipped_qty - v_already_returned;

    IF v_qty_to_return > v_returnable THEN
      RAISE EXCEPTION '반품 가능 수량 초과 — 출고: %, 이미 반품: %, 가능 잔량: %, 요청: %',
        v_item.shipped_qty, v_already_returned, v_returnable, v_qty_to_return
        USING ERRCODE = 'P0001';
    END IF;

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

  -- 174: 원영수증 vat 비례 산출 (영수증 박제 식과 동일)
  v_return_vat := CASE
    WHEN v_orig_vat_in_payment AND v_orig_supply <> 0
      THEN ROUND(v_total * v_orig_vat / v_orig_supply)
    ELSE 0
  END;

  UPDATE customers
  SET outstanding_balance = outstanding_balance - v_total,
      outstanding_vat     = outstanding_vat - v_return_vat
  WHERE id = v_orig.customer_id AND tenant_id = p_tenant_id;

  -- 174: transactions 박제 supply / vat 분리 (정공법 매트릭스 통일)
  INSERT INTO transactions (
    tenant_id, customer_id, source, type, method,
    amount, vat_type, transaction_date, order_id, description
  ) VALUES (
    p_tenant_id, v_orig.customer_id, 'return', 'income', v_orig.payment_method,
    v_total, 'supply', CURRENT_DATE, v_new_order_id, v_label
  );
  IF v_return_vat > 0 THEN
    INSERT INTO transactions (
      tenant_id, customer_id, source, type, method,
      amount, vat_type, transaction_date, order_id, description
    ) VALUES (
      p_tenant_id, v_orig.customer_id, 'return', 'income', v_orig.payment_method,
      v_return_vat, 'vat', CURRENT_DATE, v_new_order_id, v_label
    );
  END IF;

  -- 174 fix: 처리 전 vat 외상 전달
  PERFORM issue_receipt_snapshot(v_new_order_id, v_balance_before, v_old_vat_balance);

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


-- ── 6) convert_samples_bulk — v_old_vat_balance 캡쳐 추가 + 호출 변경 (136 본문 베이스) ──
-- 136 본문은 호환성 유지 + v_old_vat_balance 추가만.
CREATE OR REPLACE FUNCTION convert_samples_bulk(
  p_tenant_id        UUID,
  p_order_item_ids   JSONB
) RETURNS JSON LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_ids               UUID[];
  v_first             RECORD;
  v_item              RECORD;
  v_total             NUMERIC := 0;
  v_qty               INT     := 0;
  v_count             INT     := 0;
  v_balance_before    NUMERIC;
  v_old_vat_balance   NUMERIC;
  v_new_order_id      UUID;
  v_new_order_number  TEXT;
  v_id                UUID;
  v_credit_used       BIGINT;
BEGIN
  PERFORM assert_tenant_access(p_tenant_id);

  IF p_order_item_ids IS NULL OR jsonb_array_length(p_order_item_ids) = 0 THEN
    RETURN json_build_object('success', false, 'error', '항목이 비어있습니다.');
  END IF;

  SELECT array_agg(value::UUID) INTO v_ids
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
    v_qty   := v_qty + v_item.quantity;
    v_count := v_count + 1;
  END LOOP;

  IF v_count <> array_length(v_ids, 1) THEN
    RETURN json_build_object('success', false, 'error', '일부 항목을 찾을 수 없습니다.');
  END IF;

  UPDATE order_items
  SET sample_status = 'converted',
      updated_at    = NOW()
  WHERE id = ANY(v_ids);

  -- 174 fix: vat 외상도 캡쳐
  SELECT COALESCE(outstanding_balance, 0), COALESCE(outstanding_vat, 0)
  INTO v_balance_before, v_old_vat_balance
  FROM customers WHERE id = v_first.customer_id AND tenant_id = p_tenant_id;

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
    v_qty, v_total, v_total, v_qty,
    TRUE, FALSE,
    '샘플 매입 전환 묶음 (' || v_count || '건)'
  )
  RETURNING id INTO v_new_order_id;

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

  INSERT INTO transactions (
    tenant_id, customer_id, source, type, method,
    amount, transaction_date, order_id
  ) VALUES (
    p_tenant_id, v_first.customer_id, 'shipment', 'receivable',
    v_first.payment_method, v_total, CURRENT_DATE, v_new_order_id
  );

  UPDATE customers
  SET outstanding_balance = COALESCE(outstanding_balance, 0) + v_total
  WHERE id = v_first.customer_id AND tenant_id = p_tenant_id;

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

  -- 174 fix: 처리 전 vat 외상 전달
  PERFORM issue_receipt_snapshot(v_new_order_id, v_balance_before, v_old_vat_balance);

  RETURN json_build_object(
    'success', true,
    'new_order_id', v_new_order_id,
    'new_order_number', v_new_order_number,
    'amount', v_total,
    'qty',    v_qty,
    'count',  v_count
  );
END;
$$;

GRANT EXECUTE ON FUNCTION convert_samples_bulk(UUID, JSONB) TO authenticated;


-- Backfill 없음 — 사장 결정 2026-05-12 (서버 리셋 예정).

NOTIFY pgrst, 'reload schema';

COMMIT;
