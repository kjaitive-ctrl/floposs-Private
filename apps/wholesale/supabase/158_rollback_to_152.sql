-- ============================================================
-- 158: 154-157 운영 DB 롤백 — 152 시점 RPC 복원 + with_vat 컬럼 DROP
--
-- 관리자 결정 (2026-05-07): vat 정공법 작업 (154-157) 출혈막기 누적 → 폐기.
-- 152 시점 안정 상태 (외상=supply only / 영수증=supply only / 부가세정산=현금주의) 복원.
--
-- 이 마이그는:
-- 1) with_vat 컬럼 DROP (customers/orders 6개)
-- 2) sync_balance_from_transactions 를 147 식으로 복원 (supply only 단일 식)
-- 3) issue_receipt_snapshot 을 152 식으로 복원 (supply 박제만)
-- 4) refresh_order_revenue 를 148 식으로 복원 (vat_amount 박제 X)
-- 5) process_pending_ship 를 138 식으로 복원 (vat 박제 X)
-- 6) process_release_for_customer 를 148 식으로 복원 (vat 박제 X)
-- 7) process_return_derived 를 140 식으로 복원 (vat 박제 X)
--
-- 운영 DB 는 154-157 적용된 상태. 데이터 reset 권장 (with_vat 박제값 폐기).
-- ============================================================

-- ── 1) with_vat 컬럼 DROP ──
ALTER TABLE customers DROP COLUMN IF EXISTS outstanding_balance_with_vat;
ALTER TABLE orders    DROP COLUMN IF EXISTS outstanding_amount_with_vat;
ALTER TABLE orders
  DROP COLUMN IF EXISTS receipt_prev_balance_with_vat,
  DROP COLUMN IF EXISTS receipt_day_total_with_vat,
  DROP COLUMN IF EXISTS receipt_payment_amount_with_vat,
  DROP COLUMN IF EXISTS receipt_post_balance_with_vat;


-- ── 2) sync_balance_from_transactions = 147 식 (supply only) ──
CREATE OR REPLACE FUNCTION public.sync_balance_from_transactions()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tx_row    RECORD;
  v_order_id  UUID;
  v_customer_id UUID;
BEGIN
  v_tx_row := COALESCE(NEW, OLD);
  v_order_id := v_tx_row.order_id;
  v_customer_id := v_tx_row.customer_id;

  IF v_order_id IS NOT NULL THEN
    UPDATE orders
    SET outstanding_amount = (
      SELECT COALESCE(SUM(CASE
        WHEN source = 'shipment' THEN (amount - COALESCE(vat_amount, 0))
        WHEN source = 'return' THEN -(amount - COALESCE(vat_amount, 0))
        WHEN source IN ('payment', 'credit_apply', 'purchase') THEN -(amount - COALESCE(vat_amount, 0))
        WHEN source = 'refund' THEN (amount - COALESCE(vat_amount, 0))
        ELSE 0
      END), 0)
      FROM transactions WHERE order_id = v_order_id
    )
    WHERE id = v_order_id;
  END IF;

  IF v_customer_id IS NOT NULL THEN
    UPDATE customers
    SET outstanding_balance = (
      SELECT COALESCE(SUM(CASE
        WHEN source = 'shipment' THEN (amount - COALESCE(vat_amount, 0))
        WHEN source = 'return' THEN -(amount - COALESCE(vat_amount, 0))
        WHEN source IN ('payment', 'credit_apply', 'purchase') THEN -(amount - COALESCE(vat_amount, 0))
        WHEN source = 'refund' THEN (amount - COALESCE(vat_amount, 0))
        ELSE 0
      END), 0)
      FROM transactions WHERE customer_id = v_customer_id
    )
    WHERE id = v_customer_id;
  END IF;

  RETURN COALESCE(NEW, OLD);
END;
$$;


-- ── 3) issue_receipt_snapshot = 152 식 ──
CREATE OR REPLACE FUNCTION issue_receipt_snapshot(
  p_order_id     UUID,
  p_prev_balance NUMERIC
)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_order          RECORD;
  v_payment_method TEXT;
  v_receipt_no     TEXT;
  v_seq            INT;
  v_post_balance   NUMERIC;
  v_supply         NUMERIC;
BEGIN
  SELECT id, tenant_id, customer_id, total_amount, vat_amount, payment_method, receipt_no,
         derived_from_order_id, revenue
  INTO v_order FROM orders WHERE id = p_order_id;

  IF NOT FOUND THEN RETURN; END IF;
  IF v_order.receipt_no IS NOT NULL THEN RETURN; END IF;

  SELECT default_payment_method INTO v_payment_method
  FROM customers WHERE id = v_order.customer_id;
  v_payment_method := COALESCE(v_payment_method, v_order.payment_method, 'cash');

  v_supply := COALESCE(v_order.total_amount, 0) - COALESCE(v_order.vat_amount, 0);

  IF v_order.derived_from_order_id IS NOT NULL THEN
    v_post_balance := p_prev_balance + COALESCE(v_order.revenue, 0)::NUMERIC;
  ELSIF v_payment_method IN ('cash', 'transfer') THEN
    v_post_balance := p_prev_balance;
  ELSE
    v_post_balance := p_prev_balance + v_supply;
  END IF;

  SELECT COUNT(*) + 1 INTO v_seq
  FROM orders
  WHERE tenant_id = v_order.tenant_id
    AND receipt_issued_at IS NOT NULL
    AND receipt_issued_at::DATE = CURRENT_DATE;
  v_receipt_no := 'R' || to_char(NOW(), 'YYYYMMDD') || '-' || LPAD(v_seq::text, 4, '0');

  UPDATE orders SET
    receipt_no              = v_receipt_no,
    receipt_issued_at       = NOW(),
    receipt_prev_balance    = p_prev_balance,
    receipt_day_total       = v_supply,
    receipt_payment_method  = v_payment_method,
    receipt_payment_amount  = v_supply,
    receipt_post_balance    = v_post_balance
  WHERE id = p_order_id;
END;
$$;


-- ── 4) refresh_order_revenue = 145+148 식 (vat 박제 X, sample_convert SKIP, receipt 가드) ──
CREATE OR REPLACE FUNCTION refresh_order_revenue(p_order_id UUID)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_sales_qty        INT;
  v_revenue          BIGINT;
  v_confirmed_amount BIGINT;
  v_order_qty        INT;
  v_is_processed     BOOLEAN;
  v_has_pending      BOOLEAN;
  v_prev_processed   BOOLEAN;
  v_prev_revenue     BIGINT;
  v_tenant_id        UUID;
  v_customer_id      UUID;
  v_payment_method   TEXT;
  v_payment_status   TEXT;
  v_increment        BIGINT;
  v_old_balance      NUMERIC;
  v_credit_used      BIGINT;
  v_derived_from     UUID;
  v_order_source     TEXT;
  v_has_shipped      BOOLEAN;
  v_receipt_no       TEXT;
BEGIN
  SELECT derived_from_order_id, order_source, receipt_no
  INTO v_derived_from, v_order_source, v_receipt_no
  FROM orders WHERE id = p_order_id;
  IF v_derived_from IS NOT NULL THEN RETURN; END IF;
  IF v_order_source = 'sample_convert' THEN RETURN; END IF;
  IF v_receipt_no IS NOT NULL THEN RETURN; END IF;

  SELECT is_processed, tenant_id, customer_id, payment_method, payment_status, revenue
  INTO v_prev_processed, v_tenant_id, v_customer_id, v_payment_method, v_payment_status, v_prev_revenue
  FROM orders WHERE id = p_order_id;

  SELECT outstanding_balance INTO v_old_balance
  FROM customers WHERE id = v_customer_id AND tenant_id = v_tenant_id;

  SELECT
    COALESCE(SUM(CASE
      WHEN process_type IN ('ordered', 'backorder')
        AND NOT COALESCE(is_exchange, FALSE) AND NOT COALESCE(is_sample, FALSE)
      THEN shipped_qty ELSE 0 END), 0)
      + COALESCE(SUM(CASE
          WHEN process_type = 'backorder' AND status = 'unshipped'
            AND NOT COALESCE(is_exchange, FALSE) AND NOT COALESCE(is_sample, FALSE)
          THEN remaining_qty ELSE 0 END), 0),
    COALESCE(SUM(CASE
      WHEN process_type IN ('ordered', 'backorder')
        AND NOT COALESCE(is_exchange, FALSE) AND NOT COALESCE(is_sample, FALSE)
      THEN shipped_qty * unit_price ELSE 0 END), 0)
      + COALESCE(SUM(CASE
          WHEN process_type = 'backorder' AND status = 'unshipped'
            AND NOT COALESCE(is_exchange, FALSE) AND NOT COALESCE(is_sample, FALSE)
          THEN remaining_qty * unit_price ELSE 0 END), 0),
    COALESCE(SUM(CASE
      WHEN NOT COALESCE(is_exchange, FALSE) AND NOT COALESCE(is_sample, FALSE)
      THEN shipped_qty * unit_price ELSE 0 END), 0)
      + COALESCE(SUM(CASE
          WHEN process_type IN ('backorder', 'hold') AND status = 'unshipped'
            AND NOT COALESCE(is_exchange, FALSE) AND NOT COALESCE(is_sample, FALSE)
          THEN remaining_qty * unit_price ELSE 0 END), 0),
    COALESCE(SUM(quantity), 0),
    NOT EXISTS (SELECT 1 FROM order_items WHERE order_id = p_order_id
                AND process_type = 'ordered' AND status = 'unshipped'),
    EXISTS (SELECT 1 FROM order_items WHERE order_id = p_order_id
            AND process_type IN ('backorder', 'hold') AND status = 'unshipped')
  INTO v_sales_qty, v_revenue, v_confirmed_amount, v_order_qty, v_is_processed, v_has_pending
  FROM order_items
  WHERE order_id = p_order_id;

  SELECT EXISTS (SELECT 1 FROM order_items WHERE order_id = p_order_id AND shipped_qty > 0)
  INTO v_has_shipped;

  v_increment := CASE
    WHEN v_is_processed AND v_prev_processed AND v_revenue > v_prev_revenue
    THEN v_revenue - v_prev_revenue
    ELSE 0
  END;

  UPDATE orders
  SET sales_qty        = v_sales_qty,
      revenue          = v_revenue,
      confirmed_amount = v_confirmed_amount,
      order_qty        = v_order_qty,
      is_processed     = v_is_processed,
      has_pending      = v_has_pending,
      payment_status   = CASE WHEN v_increment > 0 THEN 'unpaid' ELSE payment_status END,
      outstanding_amount = CASE
        WHEN v_is_processed AND NOT v_prev_processed AND v_payment_status = 'unpaid' THEN v_revenue
        WHEN v_increment > 0 THEN outstanding_amount + v_increment
        ELSE outstanding_amount
      END
  WHERE id = p_order_id;

  IF v_is_processed AND NOT v_prev_processed AND v_revenue > 0 THEN
    INSERT INTO transactions (
      tenant_id, customer_id, source, type, method, amount, transaction_date, order_id
    ) VALUES (
      v_tenant_id, v_customer_id, 'shipment', 'receivable', v_payment_method,
      v_revenue, CURRENT_DATE, p_order_id
    );
    UPDATE customers SET outstanding_balance = outstanding_balance + v_revenue
    WHERE id = v_customer_id AND tenant_id = v_tenant_id;

    IF v_old_balance < 0 THEN
      v_credit_used := LEAST(ABS(v_old_balance)::BIGINT, v_revenue);
      UPDATE orders
      SET paid_amount        = COALESCE(paid_amount, 0) + v_credit_used,
          outstanding_amount = GREATEST(0, outstanding_amount - v_credit_used),
          payment_status     = CASE
            WHEN outstanding_amount - v_credit_used <= 0 THEN 'paid'
            WHEN v_credit_used > 0 THEN 'partial'
            ELSE payment_status END
      WHERE id = p_order_id;
      INSERT INTO transactions (tenant_id, customer_id, source, type, method, amount, transaction_date, order_id, description)
      VALUES (v_tenant_id, v_customer_id, 'credit_apply', 'income', NULL, v_credit_used, CURRENT_DATE, p_order_id, '매입금 자동 충당');
    END IF;
  END IF;

  IF v_is_processed AND NOT v_prev_processed AND (v_has_shipped OR v_revenue > 0) THEN
    PERFORM issue_receipt_snapshot(p_order_id, v_old_balance::NUMERIC);
  END IF;

  IF v_increment > 0 THEN
    INSERT INTO transactions (tenant_id, customer_id, source, type, method, amount, transaction_date, order_id)
    VALUES (v_tenant_id, v_customer_id, 'shipment', 'receivable', v_payment_method, v_increment, CURRENT_DATE, p_order_id);
    UPDATE customers SET outstanding_balance = outstanding_balance + v_increment
    WHERE id = v_customer_id AND tenant_id = v_tenant_id;

    IF v_old_balance < 0 THEN
      v_credit_used := LEAST(ABS(v_old_balance)::BIGINT, v_increment);
      UPDATE orders
      SET paid_amount        = COALESCE(paid_amount, 0) + v_credit_used,
          outstanding_amount = GREATEST(0, outstanding_amount - v_credit_used),
          payment_status     = CASE
            WHEN outstanding_amount - v_credit_used <= 0 THEN 'paid'
            WHEN v_credit_used > 0 THEN 'partial'
            ELSE payment_status END
      WHERE id = p_order_id;
      INSERT INTO transactions (tenant_id, customer_id, source, type, method, amount, transaction_date, order_id, description)
      VALUES (v_tenant_id, v_customer_id, 'credit_apply', 'income', NULL, v_credit_used, CURRENT_DATE, p_order_id, '매입금 자동 충당');
    END IF;
  END IF;
END;
$$;


-- ── 5) process_pending_ship = 138 식 (vat 박제 X) ──
DROP FUNCTION IF EXISTS process_pending_ship(UUID, UUID, JSONB, TEXT);

CREATE OR REPLACE FUNCTION process_pending_ship(
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
  v_credit_used         BIGINT;
BEGIN
  PERFORM assert_tenant_access(p_tenant_id);

  IF p_kind NOT IN ('backorder', 'hold') THEN
    RAISE EXCEPTION 'p_kind 는 backorder 또는 hold 만 허용' USING ERRCODE = 'P0001';
  END IF;

  v_order_source := p_kind || '_ship';
  v_suffix       := CASE p_kind WHEN 'hold' THEN 'O' ELSE 'S' END;
  v_memo_label   := CASE p_kind WHEN 'hold' THEN '보류 출고' ELSE '미송 출고' END;

  SELECT customer_id, customer_name, payment_method, order_number, order_type
  INTO v_orig
  FROM orders WHERE id = p_original_order_id AND tenant_id = p_tenant_id;
  IF NOT FOUND THEN RAISE EXCEPTION '원본 주문을 찾을 수 없습니다 (%)', p_original_order_id USING ERRCODE='P0001'; END IF;

  SELECT outstanding_balance INTO v_balance_before
  FROM customers WHERE id = v_orig.customer_id;

  FOR v_payload IN SELECT * FROM jsonb_array_elements(p_item_qty)
  LOOP
    v_qty_to_ship := (v_payload->>'qty')::INT;

    SELECT id, variant_id, unit_price, remaining_qty, process_type, is_sample, is_exchange
    INTO v_item
    FROM order_items WHERE id = (v_payload->>'item_id')::UUID;

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
    v_total, 0, 0, v_initial_outstanding,
    p_original_order_id, true, false,
    v_sales_qty, v_revenue, v_revenue, v_qty,
    v_memo_label || ' (원본: ' || v_orig.order_number || ')'
  )
  RETURNING id INTO v_new_order_id;

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

  IF p_kind = 'hold' AND v_revenue > 0 THEN
    INSERT INTO transactions (tenant_id, customer_id, source, type, method, amount, transaction_date, order_id)
    VALUES (p_tenant_id, v_orig.customer_id, 'shipment', 'receivable', v_orig.payment_method, v_revenue, CURRENT_DATE, v_new_order_id);

    UPDATE customers SET outstanding_balance = outstanding_balance + v_revenue
    WHERE id = v_orig.customer_id;

    IF v_balance_before < 0 THEN
      v_credit_used := LEAST(ABS(v_balance_before)::BIGINT, v_revenue::BIGINT);
      UPDATE orders
      SET paid_amount        = COALESCE(paid_amount, 0) + v_credit_used,
          outstanding_amount = GREATEST(0, outstanding_amount - v_credit_used),
          payment_status     = CASE
            WHEN outstanding_amount - v_credit_used <= 0 THEN 'paid'
            WHEN v_credit_used > 0 THEN 'partial'
            ELSE payment_status END
      WHERE id = v_new_order_id;
      INSERT INTO transactions (tenant_id, customer_id, source, type, method, amount, transaction_date, order_id, description)
      VALUES (p_tenant_id, v_orig.customer_id, 'credit_apply', 'income', NULL, v_credit_used, CURRENT_DATE, v_new_order_id, '매입금 자동 충당');
    END IF;
  END IF;

  PERFORM refresh_order_revenue(p_original_order_id);
  PERFORM issue_receipt_snapshot(v_new_order_id, v_balance_before);

  RETURN v_new_order_id;
END;
$$;

GRANT EXECUTE ON FUNCTION process_pending_ship(UUID, UUID, JSONB, TEXT) TO authenticated;


-- ── 6) process_release_for_customer = 148 식 (vat 박제 X) ──
CREATE OR REPLACE FUNCTION process_release_for_customer(
  p_tenant_id   UUID,
  p_customer_id UUID,
  p_items       JSONB
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
BEGIN
  PERFORM assert_tenant_access(p_tenant_id);

  IF p_items IS NULL OR jsonb_array_length(p_items) = 0 THEN
    RETURN json_build_object('success', false, 'error', '항목이 비어있습니다.');
  END IF;

  SELECT o.id AS order_id, o.customer_name, o.payment_method, o.order_number, o.order_type
  INTO v_orig
  FROM order_items oi
  JOIN orders o ON o.id = oi.order_id
  WHERE oi.id = (p_items->0->>'item_id')::UUID
    AND o.tenant_id = p_tenant_id
    AND o.customer_id = p_customer_id;

  IF NOT FOUND THEN RETURN json_build_object('success', false, 'error', '첫 항목을 찾을 수 없습니다.'); END IF;
  v_first_order_id := v_orig.order_id;

  SELECT outstanding_balance INTO v_balance_before FROM customers WHERE id = p_customer_id;

  FOR v_payload IN SELECT * FROM jsonb_array_elements(p_items)
  LOOP
    v_item_id := (v_payload->>'item_id')::UUID;
    v_qty     := (v_payload->>'qty')::INT;

    SELECT oi.id, oi.variant_id, oi.unit_price, oi.process_type, oi.is_sample, oi.is_exchange,
           oi.remaining_qty, o.customer_id
    INTO v_item
    FROM order_items oi
    JOIN orders o ON o.id = oi.order_id
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
    -v_total_amount, 0, 0, -v_total_amount,
    v_first_order_id, true, false,
    -v_total_qty, -v_total_amount, -v_total_amount, v_total_qty,
    '미송해제 (' || v_total_qty || '개)'
  )
  RETURNING id INTO v_new_order_id;

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

  UPDATE customers SET outstanding_balance = outstanding_balance - v_total_amount
  WHERE id = p_customer_id AND tenant_id = p_tenant_id;

  INSERT INTO transactions (tenant_id, customer_id, source, type, method, amount, transaction_date, order_id, description)
  VALUES (p_tenant_id, p_customer_id, 'shipment', 'receivable', v_orig.payment_method,
          -v_total_amount, CURRENT_DATE, v_new_order_id, '미송해제');

  PERFORM issue_receipt_snapshot(v_new_order_id, v_balance_before);

  RETURN json_build_object(
    'success', true, 'new_order_id', v_new_order_id, 'new_order_number', v_new_order_number,
    'amount', -v_total_amount, 'count', v_total_qty
  );
END;
$$;

GRANT EXECUTE ON FUNCTION process_release_for_customer(UUID, UUID, JSONB) TO authenticated;


-- ── 7) process_return_derived = 140 식 (vat 박제 X) ──
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
  INTO v_orig FROM orders WHERE id = p_order_id AND tenant_id = p_tenant_id;
  IF NOT FOUND THEN RETURN json_build_object('success', false, 'error', '원 주문을 찾을 수 없습니다.'); END IF;

  SELECT outstanding_balance INTO v_balance_before FROM customers WHERE id = v_orig.customer_id;

  v_new_order_number := v_orig.order_number || '-RT'
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
    'return', 'shipped', v_orig.payment_method, 'paid',
    0, 0, 0, 0, p_order_id, true, false,
    0, 0, 0, 0,
    v_label || ' (원본: ' || v_orig.order_number || ')'
  )
  RETURNING id INTO v_new_order_id;

  FOR v_payload IN SELECT * FROM jsonb_array_elements(p_items)
  LOOP
    v_item_id       := (v_payload->>'item_id')::UUID;
    v_qty_to_return := (v_payload->>'qty')::INT;
    IF v_qty_to_return <= 0 THEN CONTINUE; END IF;

    SELECT id, variant_id, unit_price, is_sample
    INTO v_item FROM order_items WHERE id = v_item_id;
    IF NOT FOUND THEN CONTINUE; END IF;

    UPDATE inventory SET quantity = quantity + v_qty_to_return, updated_at = NOW()
    WHERE tenant_id = p_tenant_id AND variant_id = v_item.variant_id
    RETURNING quantity INTO v_inv_qty;

    INSERT INTO inventory_logs (tenant_id, variant_id, order_item_id, qty_change, balance_after, reason)
    VALUES (p_tenant_id, v_item.variant_id, v_item_id, v_qty_to_return, COALESCE(v_inv_qty, 0), p_reason);

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
  SET total_amount = -v_total, outstanding_amount = -v_total,
      sales_qty = -v_qty, revenue = -v_total, confirmed_amount = -v_total, order_qty = v_qty
  WHERE id = v_new_order_id;

  UPDATE customers SET outstanding_balance = outstanding_balance - v_total
  WHERE id = v_orig.customer_id AND tenant_id = p_tenant_id;

  INSERT INTO transactions (tenant_id, customer_id, source, type, method, amount, transaction_date, order_id, description)
  VALUES (p_tenant_id, v_orig.customer_id, 'return', 'income', v_orig.payment_method,
          v_total, CURRENT_DATE, v_new_order_id, v_label);

  PERFORM issue_receipt_snapshot(v_new_order_id, v_balance_before);

  RETURN json_build_object(
    'success', true, 'new_order_id', v_new_order_id,
    'new_order_number', v_new_order_number, 'amount', -v_total, 'count', v_qty
  );
END;
$$;

GRANT EXECUTE ON FUNCTION process_return_derived(UUID, UUID, JSONB, TEXT) TO authenticated;


-- ── 일괄 재계산 (외상 정합) ──
UPDATE customers c SET outstanding_balance = (
  SELECT COALESCE(SUM(CASE
    WHEN source = 'shipment' THEN (amount - COALESCE(vat_amount, 0))
    WHEN source = 'return' THEN -(amount - COALESCE(vat_amount, 0))
    WHEN source IN ('payment', 'credit_apply', 'purchase') THEN -(amount - COALESCE(vat_amount, 0))
    WHEN source = 'refund' THEN (amount - COALESCE(vat_amount, 0))
    ELSE 0
  END), 0)
  FROM transactions WHERE customer_id = c.id
);

UPDATE orders o SET outstanding_amount = (
  SELECT COALESCE(SUM(CASE
    WHEN source = 'shipment' THEN (amount - COALESCE(vat_amount, 0))
    WHEN source = 'return' THEN -(amount - COALESCE(vat_amount, 0))
    WHEN source IN ('payment', 'credit_apply', 'purchase') THEN -(amount - COALESCE(vat_amount, 0))
    WHEN source = 'refund' THEN (amount - COALESCE(vat_amount, 0))
    ELSE 0
  END), 0)
  FROM transactions WHERE order_id = o.id
)
WHERE EXISTS (SELECT 1 FROM transactions WHERE order_id = o.id);

NOTIFY pgrst, 'reload schema';
