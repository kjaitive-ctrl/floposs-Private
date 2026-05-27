-- ============================================================
-- 163: 정공법 재설계 — 처리 액션 1:1 derived 영수증 박제 모델 (2026-05-08)
--
-- 사장 합의:
--   "주문등록 시점에 영수증 확정 짓는게 계속 문제가 됨. 출혈막기식 진행."
--   "처리 시점에 확정. 미처리된 부분주문은 모두 사라져야함."
--   "출고+미송 동시 토글 = 잔여 미송으로 살림. 그 외 잔여는 자동 폐기."
--
-- 모델:
--   주문등록 (staging): orders.receipt_no 절대 박제 X. order_items 컨테이너 역할.
--   처리 액션: 새 derived order 생성 (1 액션 = 1 derived = 1 영수증).
--   staging 잔여: 처리 안 한 항목은 자동 폐기 (DELETE order_items + DELETE staging order).
--
-- 처리 액션 종류:
--   shipment           — 당일 출고. 매출+외상+vat+영수증 박제. 재고 차감.
--   backorder_register — 미송 등록. 매출+외상+vat+영수증 박제 (등록=확정). 재고 차감 X.
--   hold_register      — 보류 등록. 매출/외상/영수증 모두 X (대기 상태).
--
-- 후속 액션 (162 RPC 그대로 활용):
--   process_pending_ship('backorder') — 미송 출고. 새 derived. 매출 변동 X (이미 박제). 영수증 (확인용).
--   process_pending_ship('hold')      — 보류 출고. 새 derived. 매출+외상+영수증 첫 박제 (162 분기 그대로).
--   process_release_for_customer      — 미송 해제. 음수 derived.
--   process_return_derived            — 반품. 음수 derived.
--   convert_samples_bulk              — 샘플 매입전환.
--
-- 폐기:
--   refresh_order_revenue   — 기존 staging 매출 박제 모델용. 정공법에선 의미 X.
--   process_status          — process_type 단순 변경. 새 모델에선 처리=derived 분리라 의미 X.
--   trg_order_items_revenue — order_items 변경 시 refresh 자동 호출 트리거. refresh 폐기로 의미 X.
--
-- 의존성:
--   162 적용 후. vat ledger / outstanding_vat / receipt_* 컬럼 그대로 활용.
--   issue_receipt_snapshot / process_payment / process_refund / process_vat_collection
--     / process_release_for_customer / process_return_derived / convert_samples_bulk
--     / sync_balance_from_transactions — 162 그대로 유지.
-- ============================================================

BEGIN;

-- ── 0) 폐기 ──────────────────────────────────────────────
-- 트리거 먼저 제거 (이후 order_items 변경 시 refresh 자동 호출 차단).
-- 함수 본문 의존성: 162 process_pending_ship 만 PERFORM refresh 호출. 본 마이그 [2)] 에서 재작성으로 제거.
-- 동일 트랜잭션이라 commit 시점에 일관성 보장. 중간 호출 시 일시 깨짐 위험 X (단일 트랜잭션).
DROP TRIGGER IF EXISTS trg_order_items_revenue ON order_items;
DROP FUNCTION IF EXISTS public.refresh_order_revenue(UUID);
DROP FUNCTION IF EXISTS public.process_status(UUID, TEXT, UUID);


-- ── 1) process_register_action — 처리 액션 통합 RPC ──────
-- p_actions JSONB 형식:
--   [
--     {"kind": "shipment",            "items": [{"item_id": "...", "qty": 2}, ...]},
--     {"kind": "backorder_register",  "items": [{"item_id": "...", "qty": 1}, ...]},
--     {"kind": "hold_register",       "items": [{"item_id": "...", "qty": 1}, ...]}
--   ]
-- 한 item_id 가 여러 action 에 등장 가능 (출고+미송 split).
-- 합계 qty ≤ staging order_items.quantity 검증.
-- staging 잔여 (어떤 action 에도 등장 X 또는 등장했지만 합계 < quantity) → 자동 폐기.
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
BEGIN
  PERFORM assert_tenant_access(p_tenant_id);

  IF p_actions IS NULL OR jsonb_array_length(p_actions) = 0 THEN
    RAISE EXCEPTION '처리할 액션이 없습니다' USING ERRCODE = 'P0001';
  END IF;

  -- staging order 검증
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

  -- ── 검증: 각 item_id 별 사용 qty 합계 ≤ staging.quantity ──
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

  -- ── 액션별 처리 ──
  FOR v_action IN SELECT * FROM jsonb_array_elements(p_actions)
  LOOP
    v_kind  := v_action->>'kind';
    v_items := v_action->'items';

    IF v_kind NOT IN ('shipment', 'backorder_register', 'hold_register') THEN
      RAISE EXCEPTION 'kind 는 shipment / backorder_register / hold_register 만 허용 (%)', v_kind USING ERRCODE='P0001';
    END IF;
    IF v_items IS NULL OR jsonb_array_length(v_items) = 0 THEN CONTINUE; END IF;

    -- 합계 (이번 액션의 v_total / v_total_qty)
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

    -- vat / 외상 / 영수증 박제 분기
    IF v_kind IN ('shipment', 'backorder_register') THEN
      v_inc_vat := ROUND(v_total * v_vat_rate)::BIGINT;
      v_new_vat_amount := CASE WHEN v_orig_vat_in_payment THEN ROUND(v_total * v_vat_rate) ELSE 0 END;
      v_initial_outstanding := v_total;
      v_payment_status := 'unpaid';
    ELSE  -- hold_register
      v_inc_vat := 0;
      v_new_vat_amount := 0;
      v_initial_outstanding := 0;
      v_payment_status := 'paid';
    END IF;

    -- 거래처 현재 outstanding (액션마다 새로 SELECT — 직전 액션 충당 반영)
    SELECT COALESCE(outstanding_balance, 0), COALESCE(outstanding_vat, 0)
    INTO v_balance_before, v_old_vat_balance
    FROM customers WHERE id = v_staging.customer_id;

    v_new_order_number := v_staging.order_number || '-' || v_suffix
      || substr(replace(gen_random_uuid()::text, '-', ''), 1, 4);

    -- 새 derived order INSERT
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
      v_kind <> 'shipment',  -- has_pending: 미송/보류 register 는 출고 대기
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

    -- order_items 복사 (kind 별 status/process_type/재고)
    FOR v_payload IN SELECT * FROM jsonb_array_elements(v_items)
    LOOP
      v_qty := (v_payload->>'qty')::INT;
      IF v_qty <= 0 THEN CONTINUE; END IF;
      SELECT id, variant_id, unit_price, quantity, is_sample, is_exchange
      INTO v_item FROM order_items
      WHERE id = (v_payload->>'item_id')::UUID AND order_id = p_staging_order_id;
      IF NOT FOUND THEN CONTINUE; END IF;

      IF v_kind = 'shipment' THEN
        -- 재고 검증 + 차감 (FOR UPDATE)
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

    -- 매출/외상/vat/영수증 박제 (shipment/backorder_register 만)
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

      -- 매입금 자동 충당 (supply / vat 분리)
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

      -- 영수증 박제 (issue_receipt_snapshot 162 그대로)
      PERFORM issue_receipt_snapshot(v_new_order_id, v_balance_before);
    END IF;
    -- hold_register: 외상/매출/영수증 X (대기)

    v_derived_ids := array_append(v_derived_ids, v_new_order_id);
  END LOOP;

  -- ── 잔여 폐기 + staging 삭제 ──
  -- 처리 안 된 items / 처리됐지만 합계 < quantity 인 잔여 모두 자동 폐기 (정공법 결정 2026-05-08).
  DELETE FROM order_items WHERE order_id = p_staging_order_id;
  DELETE FROM orders WHERE id = p_staging_order_id;

  RETURN json_build_object(
    'success', true,
    'derived_order_ids', to_jsonb(v_derived_ids),
    'staging_deleted', true
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.process_register_action(UUID, UUID, JSONB) TO authenticated;


-- ── 2) process_pending_ship 재작성 (162 그대로 + PERFORM refresh 제거) ──
-- 정공법: refresh_order_revenue 폐기. 부모 derived (backorder_register / hold_register) 의
--         박제값은 immutable 이므로 refresh 호출이 의미 없음.
DROP FUNCTION IF EXISTS public.process_pending_ship(UUID, UUID, JSONB, TEXT);

CREATE OR REPLACE FUNCTION public.process_pending_ship(
  p_tenant_id          UUID,
  p_original_order_id  UUID,
  p_item_qty           JSONB,
  p_kind               TEXT
)
RETURNS UUID LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_orig                RECORD;
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

  v_order_source := p_kind || '_ship';
  v_suffix       := CASE p_kind WHEN 'hold' THEN 'O' ELSE 'S' END;
  v_memo_label   := CASE p_kind WHEN 'hold' THEN '보류 출고' ELSE '미송 출고' END;

  SELECT customer_id, customer_name, payment_method, order_number, order_type, vat_amount
  INTO v_orig
  FROM orders WHERE id = p_original_order_id AND tenant_id = p_tenant_id;
  IF NOT FOUND THEN RAISE EXCEPTION '원본 주문을 찾을 수 없습니다 (%)', p_original_order_id USING ERRCODE='P0001'; END IF;
  v_orig_vat_in_payment := COALESCE(v_orig.vat_amount, 0) > 0;

  SELECT COALESCE(outstanding_balance, 0), COALESCE(outstanding_vat, 0)
  INTO v_balance_before, v_old_vat_balance
  FROM customers WHERE id = v_orig.customer_id;

  SELECT COALESCE(vat_rate, 0.10) INTO v_vat_rate FROM tenants WHERE id = p_tenant_id;

  FOR v_payload IN SELECT * FROM jsonb_array_elements(p_item_qty)
  LOOP
    v_qty_to_ship := (v_payload->>'qty')::INT;
    SELECT id, variant_id, unit_price, remaining_qty, process_type, is_sample, is_exchange
    INTO v_item FROM order_items WHERE id = (v_payload->>'item_id')::UUID;
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

  v_initial_outstanding := CASE WHEN p_kind = 'hold' THEN v_revenue ELSE 0 END;
  v_new_vat_amount := CASE WHEN v_orig_vat_in_payment THEN ROUND(v_total * v_vat_rate) ELSE 0 END;
  v_inc_vat := CASE WHEN p_kind = 'hold' THEN ROUND(v_revenue * v_vat_rate)::BIGINT ELSE 0 END;

  v_new_order_number := v_orig.order_number || '-' || v_suffix
    || substr(replace(gen_random_uuid()::text, '-', ''), 1, 4);

  INSERT INTO orders (
    tenant_id, customer_id, customer_name, order_number, order_type,
    order_source, status, payment_method, payment_status,
    total_amount, vat_amount, paid_amount, outstanding_amount,
    derived_from_order_id, is_processed, has_pending,
    sales_qty, revenue, confirmed_amount, order_qty, memo
  ) VALUES (
    p_tenant_id, v_orig.customer_id, v_orig.customer_name, v_new_order_number,
    COALESCE(v_orig.order_type, 'wholesale'),
    v_order_source, 'shipped', v_orig.payment_method, 'unpaid',
    v_total, v_new_vat_amount, 0, v_initial_outstanding,
    p_original_order_id, true, false,
    v_sales_qty, v_revenue, v_revenue, v_qty,
    v_memo_label || ' (원본: ' || v_orig.order_number || ')'
  )
  RETURNING id INTO v_new_order_id;

  FOR v_payload IN SELECT * FROM jsonb_array_elements(p_item_qty)
  LOOP
    v_qty_to_ship := (v_payload->>'qty')::INT;
    SELECT variant_id, unit_price, is_sample, is_exchange
    INTO v_item FROM order_items WHERE id = (v_payload->>'item_id')::UUID;

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
    -- 보류 출고: 매출/외상/vat 첫 박제 (162 분기 그대로)
    INSERT INTO transactions (tenant_id, customer_id, source, type, method, amount, vat_type, transaction_date, order_id)
    VALUES (p_tenant_id, v_orig.customer_id, 'shipment', 'receivable', v_orig.payment_method, v_revenue, 'supply', CURRENT_DATE, v_new_order_id);
    IF v_inc_vat > 0 THEN
      INSERT INTO transactions (tenant_id, customer_id, source, type, method, amount, vat_type, transaction_date, order_id)
      VALUES (p_tenant_id, v_orig.customer_id, 'shipment', 'receivable', v_orig.payment_method, v_inc_vat, 'vat', CURRENT_DATE, v_new_order_id);
    END IF;

    UPDATE customers
    SET outstanding_balance = outstanding_balance + v_revenue,
        outstanding_vat     = outstanding_vat + v_inc_vat
    WHERE id = v_orig.customer_id;

    -- 매입금 충당 (supply / vat 분리)
    IF v_balance_before < 0 THEN
      v_credit_supply := LEAST(ABS(v_balance_before)::BIGINT, v_revenue::BIGINT);
      INSERT INTO transactions (tenant_id, customer_id, source, type, method, amount, vat_type, transaction_date, order_id, description)
      VALUES (p_tenant_id, v_orig.customer_id, 'credit_apply', 'income', NULL, v_credit_supply, 'supply', CURRENT_DATE, v_new_order_id, '매입금 자동 충당 (공급가)');
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
      VALUES (p_tenant_id, v_orig.customer_id, 'credit_apply', 'income', NULL, v_credit_vat, 'vat', CURRENT_DATE, v_new_order_id, '매입금 자동 충당 (부가세)');
    END IF;
  END IF;

  -- 162 와 차이: PERFORM refresh_order_revenue(p_original_order_id) 제거.
  --   refresh_order_revenue 폐기 + 부모 derived 박제값 immutable 원칙.
  PERFORM issue_receipt_snapshot(v_new_order_id, v_balance_before);

  RETURN v_new_order_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.process_pending_ship(UUID, UUID, JSONB, TEXT) TO authenticated;


NOTIFY pgrst, 'reload schema';

COMMIT;
