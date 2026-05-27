-- ============================================================
-- 162: 153 base + vat ledger 평행 (매트릭스 합의 2026-05-07)
--
-- 161 에서 변경:
--   1) issue_receipt_snapshot: 현금 자동결제 분기 폐기 (현금도 외상+, list 버튼으로 결제)
--   2) issue_receipt_snapshot: vat_in_payment 분기로 prev/post 표시값 박제 (with_vat / supply only)
--   3) shipment 류 RPC: vat 행 항상 INSERT (saleform vat off 강제 케이스도 박제용)
--      - refresh_order_revenue / process_pending_ship / process_release / process_return / convert_samples_bulk
--      - amount = ROUND(supply * vat_rate), orders.vat_amount 무관
--   4) 매입금 자동 충당: supply 분 / vat 분 분리 (그대로 유지)
--   5) 외상 sync trigger: vat_type 별 독립 SUM (그대로 유지)
--
-- 매트릭스:
--   외상 = supply only (153 식 정합 보존)
--   vat 외상 = customers.outstanding_vat 별도 ledger
--   영수증 list 외상 컬럼: supply only
--   영수증 본문 prev/post: vat_in_payment 면 supply+vat / 아니면 supply only
--   영수증 vat 라인 표시: vat_in_payment 분기
-- ============================================================

-- ── 0) 컬럼 idempotent (159/161 에서 이미 추가됨) ──
ALTER TABLE transactions
  ADD COLUMN IF NOT EXISTS vat_type TEXT NOT NULL DEFAULT 'supply'
  CHECK (vat_type IN ('supply', 'vat'));
CREATE INDEX IF NOT EXISTS idx_transactions_vat_type ON transactions(vat_type);

ALTER TABLE customers
  ADD COLUMN IF NOT EXISTS outstanding_vat NUMERIC NOT NULL DEFAULT 0;

ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS receipt_supply_amount NUMERIC,
  ADD COLUMN IF NOT EXISTS receipt_vat_amount NUMERIC,
  ADD COLUMN IF NOT EXISTS receipt_total_amount NUMERIC,
  ADD COLUMN IF NOT EXISTS receipt_vat_in_payment BOOLEAN;

ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS vat_rate NUMERIC DEFAULT 0.10;


-- ── 0.5) process_vat_collection — vat_type='vat' 명시 (162) ──
CREATE OR REPLACE FUNCTION public.process_vat_collection(
  p_tenant_id    uuid,
  p_customer_id  uuid,
  p_amount       bigint,
  p_method       text,
  p_period_month text DEFAULT NULL
)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  PERFORM assert_tenant_access(p_tenant_id);

  IF p_amount <= 0 THEN
    RAISE EXCEPTION '부가세 입금액은 양수여야 합니다 (%)', p_amount;
  END IF;

  -- 162 매트릭스: vat_collection = 부가세 정산 입금. vat_type='vat' 박제 → outstanding_vat 차감.
  INSERT INTO transactions (
    tenant_id, customer_id, source, type, method,
    amount, vat_type, transaction_date,
    vat_mode, vat_amount,
    description
  ) VALUES (
    p_tenant_id, p_customer_id, 'vat_collection', 'income', p_method,
    p_amount, 'vat', CURRENT_DATE,
    'vat_only', p_amount,
    COALESCE(p_period_month, '')
  );
END;
$$;


-- ── 1) sync_balance_from_transactions = vat_type 별 독립 SUM (vat_collection 추가) ──
CREATE OR REPLACE FUNCTION public.sync_balance_from_transactions()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
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
        WHEN source IN ('shipment', 'refund') THEN amount
        WHEN source IN ('return', 'payment', 'credit_apply', 'purchase', 'vat_collection') THEN -amount
        ELSE 0
      END), 0)
      FROM transactions WHERE order_id = v_order_id AND vat_type = 'supply'
    )
    WHERE id = v_order_id;
  END IF;

  IF v_customer_id IS NOT NULL THEN
    UPDATE customers
    SET outstanding_balance = (
        SELECT COALESCE(SUM(CASE
          WHEN source IN ('shipment', 'refund') THEN amount
          WHEN source IN ('return', 'payment', 'credit_apply', 'purchase') THEN -amount
          ELSE 0
        END), 0)
        FROM transactions WHERE customer_id = v_customer_id AND vat_type = 'supply'
      ),
      outstanding_vat = (
        SELECT COALESCE(SUM(CASE
          WHEN source IN ('shipment', 'refund') THEN amount
          WHEN source IN ('return', 'payment', 'credit_apply', 'purchase', 'vat_collection') THEN -amount
          ELSE 0
        END), 0)
        FROM transactions WHERE customer_id = v_customer_id AND vat_type = 'vat'
      )
    WHERE id = v_customer_id;
  END IF;

  RETURN COALESCE(NEW, OLD);
END;
$$;


-- ── 2) issue_receipt_snapshot — 자동결제 분기 폐기 + vat_in_payment 분기 박제 ──
CREATE OR REPLACE FUNCTION issue_receipt_snapshot(
  p_order_id     UUID,
  p_prev_balance NUMERIC
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
  v_prev_balance_vat   NUMERIC;
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

  -- vat_in_payment + vat 박제
  -- derived (반품/해제) 는 원영수증 vat_in_payment 상속 + 원영수증 vat 비례
  -- 일반 주문은 orders.vat_amount > 0 이면 vat_in_payment=true
  IF v_order.derived_from_order_id IS NOT NULL THEN
    SELECT COALESCE(receipt_vat_in_payment, false),
           COALESCE(receipt_supply_amount, 0),
           COALESCE(receipt_vat_amount, 0)
    INTO v_vat_in_payment, v_orig_supply, v_orig_vat
    FROM orders WHERE id = v_order.derived_from_order_id;

    IF v_order.order_source IN ('return', 'backorder_release') AND v_orig_supply <> 0 THEN
      v_vat := ROUND(v_supply * v_orig_vat / v_orig_supply);
    ELSE
      v_vat := ROUND(v_supply * v_vat_rate);
    END IF;
  ELSE
    v_vat_in_payment := COALESCE(v_order.vat_amount, 0) > 0;
    v_vat := ROUND(v_supply * v_vat_rate);
  END IF;

  v_total := v_supply + v_vat;

  -- 결제액: 박제 시점 transactions(payment, credit_apply) supply+vat 합산
  -- vat_in_payment 면 with_vat 합 / 아니면 supply 만
  IF v_vat_in_payment THEN
    SELECT COALESCE(SUM(amount), 0) INTO v_payment_amount
    FROM transactions
    WHERE order_id = p_order_id AND source IN ('payment', 'credit_apply');
  ELSE
    SELECT COALESCE(SUM(amount), 0) INTO v_payment_amount
    FROM transactions
    WHERE order_id = p_order_id AND source IN ('payment', 'credit_apply') AND vat_type = 'supply';
  END IF;

  -- prev_balance 표시값: vat_in_payment 면 supply 외상 + vat 외상 / 아니면 supply only
  SELECT COALESCE(outstanding_vat, 0) INTO v_prev_balance_vat
  FROM customers WHERE id = v_order.customer_id;

  v_prev_balance_disp := CASE
    WHEN v_vat_in_payment THEN p_prev_balance + v_prev_balance_vat
    ELSE p_prev_balance
  END;

  -- 매트릭스 Row 6: 영수증 전잔/당일/당잔 = vat_in_payment 면 with_vat / 아니면 supply only
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


-- ── 3) refresh_order_revenue — vat 행 항상 INSERT (vat_amount 무관) ──
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
  v_old_vat_balance  NUMERIC;
  v_credit_supply    BIGINT;
  v_credit_vat       BIGINT;
  v_derived_from     UUID;
  v_order_source     TEXT;
  v_has_shipped      BOOLEAN;
  v_receipt_no       TEXT;
  v_vat_rate         NUMERIC;
  v_inc_vat          BIGINT;
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

  SELECT COALESCE(outstanding_balance, 0), COALESCE(outstanding_vat, 0)
  INTO v_old_balance, v_old_vat_balance
  FROM customers WHERE id = v_customer_id AND tenant_id = v_tenant_id;

  SELECT COALESCE(vat_rate, 0.10) INTO v_vat_rate
  FROM tenants WHERE id = v_tenant_id;

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
          WHEN process_type = 'backorder' AND status = 'unshipped'
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

  -- 첫 처리 매출 박제 (supply 행 + vat 행 항상 분리 INSERT)
  IF v_is_processed AND NOT v_prev_processed AND v_revenue > 0 THEN
    v_inc_vat := ROUND(v_revenue * v_vat_rate)::BIGINT;

    -- supply 행
    INSERT INTO transactions (
      tenant_id, customer_id, source, type, method, amount, vat_type, transaction_date, order_id
    ) VALUES (
      v_tenant_id, v_customer_id, 'shipment', 'receivable', v_payment_method,
      v_revenue, 'supply', CURRENT_DATE, p_order_id
    );
    -- vat 행 (항상 — vat_amount 무관)
    IF v_inc_vat > 0 THEN
      INSERT INTO transactions (
        tenant_id, customer_id, source, type, method, amount, vat_type, transaction_date, order_id
      ) VALUES (
        v_tenant_id, v_customer_id, 'shipment', 'receivable', v_payment_method,
        v_inc_vat, 'vat', CURRENT_DATE, p_order_id
      );
    END IF;

    UPDATE customers
    SET outstanding_balance = outstanding_balance + v_revenue,
        outstanding_vat     = outstanding_vat + v_inc_vat
    WHERE id = v_customer_id AND tenant_id = v_tenant_id;

    -- 매입금 자동 충당 (supply / vat 분리)
    IF v_old_balance < 0 THEN
      v_credit_supply := LEAST(ABS(v_old_balance)::BIGINT, v_revenue);
      INSERT INTO transactions (tenant_id, customer_id, source, type, method, amount, vat_type, transaction_date, order_id, description)
      VALUES (v_tenant_id, v_customer_id, 'credit_apply', 'income', NULL, v_credit_supply, 'supply', CURRENT_DATE, p_order_id, '매입금 자동 충당 (공급가)');
    END IF;
    IF v_old_vat_balance < 0 AND v_inc_vat > 0 THEN
      v_credit_vat := LEAST(ABS(v_old_vat_balance)::BIGINT, v_inc_vat);
      INSERT INTO transactions (tenant_id, customer_id, source, type, method, amount, vat_type, transaction_date, order_id, description)
      VALUES (v_tenant_id, v_customer_id, 'credit_apply', 'income', NULL, v_credit_vat, 'vat', CURRENT_DATE, p_order_id, '매입금 자동 충당 (부가세)');
    END IF;

    -- order outstanding_amount paid 처리 (supply 충당분만)
    IF v_old_balance < 0 THEN
      UPDATE orders
      SET paid_amount        = COALESCE(paid_amount, 0) + LEAST(ABS(v_old_balance)::BIGINT, v_revenue),
          outstanding_amount = GREATEST(0, outstanding_amount - LEAST(ABS(v_old_balance)::BIGINT, v_revenue)),
          payment_status     = CASE
            WHEN outstanding_amount - LEAST(ABS(v_old_balance)::BIGINT, v_revenue) <= 0 THEN 'paid'
            WHEN LEAST(ABS(v_old_balance)::BIGINT, v_revenue) > 0 THEN 'partial'
            ELSE payment_status END
      WHERE id = p_order_id;
    END IF;
  END IF;

  IF v_is_processed AND NOT v_prev_processed AND (v_has_shipped OR v_revenue > 0) THEN
    PERFORM issue_receipt_snapshot(p_order_id, v_old_balance::NUMERIC);
  END IF;

  -- 부분처리 증분 (영수증 박제 후엔 receipt_no 가드로 진입 안 됨)
  IF v_increment > 0 THEN
    v_inc_vat := ROUND(v_increment * v_vat_rate)::BIGINT;

    INSERT INTO transactions (tenant_id, customer_id, source, type, method, amount, vat_type, transaction_date, order_id)
    VALUES (v_tenant_id, v_customer_id, 'shipment', 'receivable', v_payment_method, v_increment, 'supply', CURRENT_DATE, p_order_id);
    IF v_inc_vat > 0 THEN
      INSERT INTO transactions (tenant_id, customer_id, source, type, method, amount, vat_type, transaction_date, order_id)
      VALUES (v_tenant_id, v_customer_id, 'shipment', 'receivable', v_payment_method, v_inc_vat, 'vat', CURRENT_DATE, p_order_id);
    END IF;
    UPDATE customers
    SET outstanding_balance = outstanding_balance + v_increment,
        outstanding_vat     = outstanding_vat + v_inc_vat
    WHERE id = v_customer_id AND tenant_id = v_tenant_id;
  END IF;
END;
$$;


-- ── 4) process_payment — supply / vat 행 분리 (161식 그대로) ──
CREATE OR REPLACE FUNCTION public.process_payment(
  p_tenant_id uuid, p_customer_id uuid, p_amount bigint, p_method text,
  p_source text, p_order_id uuid DEFAULT NULL,
  p_vat_mode text DEFAULT NULL, p_vat_amount bigint DEFAULT 0
)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_supply  BIGINT := p_amount - COALESCE(p_vat_amount, 0);
  v_vat     BIGINT := COALESCE(p_vat_amount, 0);
BEGIN
  PERFORM assert_tenant_access(p_tenant_id);

  IF v_supply <> 0 THEN
    INSERT INTO transactions (
      tenant_id, customer_id, source, type, method, amount, vat_type,
      transaction_date, order_id, vat_mode
    ) VALUES (
      p_tenant_id, p_customer_id, p_source, 'income', p_method, v_supply, 'supply',
      CURRENT_DATE, p_order_id, p_vat_mode
    );
  END IF;

  IF v_vat <> 0 THEN
    INSERT INTO transactions (
      tenant_id, customer_id, source, type, method, amount, vat_type,
      transaction_date, order_id, vat_mode
    ) VALUES (
      p_tenant_id, p_customer_id, p_source, 'income', p_method, v_vat, 'vat',
      CURRENT_DATE, p_order_id, p_vat_mode
    );
  END IF;

  IF p_order_id IS NOT NULL THEN
    UPDATE orders
    SET paid_amount    = COALESCE(paid_amount, 0) + v_supply,
        payment_status = CASE
          WHEN outstanding_amount - v_supply <= 0 THEN 'paid'
          ELSE 'partial'
        END
    WHERE id = p_order_id AND tenant_id = p_tenant_id;
  END IF;
END;
$$;


-- ── 5) process_refund — supply / vat 행 분리 (161식 그대로) ──
CREATE OR REPLACE FUNCTION public.process_refund(
  p_tenant_id uuid, p_customer_id uuid, p_amount bigint, p_method text,
  p_vat_mode text DEFAULT NULL, p_vat_amount bigint DEFAULT 0
)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_supply BIGINT := p_amount - COALESCE(p_vat_amount, 0);
  v_vat    BIGINT := COALESCE(p_vat_amount, 0);
BEGIN
  PERFORM assert_tenant_access(p_tenant_id);

  IF v_supply <> 0 THEN
    INSERT INTO transactions (
      tenant_id, customer_id, source, type, method, amount, vat_type,
      transaction_date, vat_mode
    ) VALUES (
      p_tenant_id, p_customer_id, 'refund', 'expense', p_method, v_supply, 'supply',
      CURRENT_DATE, p_vat_mode
    );
  END IF;
  IF v_vat <> 0 THEN
    INSERT INTO transactions (
      tenant_id, customer_id, source, type, method, amount, vat_type,
      transaction_date, vat_mode
    ) VALUES (
      p_tenant_id, p_customer_id, 'refund', 'expense', p_method, v_vat, 'vat',
      CURRENT_DATE, p_vat_mode
    );
  END IF;
END;
$$;


-- ── 6) process_pending_ship — vat 행 항상 INSERT ──
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
  -- orders.vat_amount 박제 = 원영수증 vat_in_payment 상속 (영수증 표시용)
  v_new_vat_amount := CASE WHEN v_orig_vat_in_payment THEN ROUND(v_total * v_vat_rate) ELSE 0 END;
  -- transactions vat 행 amount = 항상 supply * vat_rate (vat_in_payment 무관)
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
    -- shipment 행 분리 (supply + vat 항상)
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

  PERFORM refresh_order_revenue(p_original_order_id);
  PERFORM issue_receipt_snapshot(v_new_order_id, v_balance_before);

  RETURN v_new_order_id;
END;
$$;

GRANT EXECUTE ON FUNCTION process_pending_ship(UUID, UUID, JSONB, TEXT) TO authenticated;


-- ── 7) process_release_for_customer — 음수 supply / vat 행 항상 ──
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

  -- vat 비례 음수 (항상 — 미송 등록 시 vat 행도 INSERT 됐으므로 정합 유지)
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

  -- 음수 supply / vat 행 분리 (vat 행 항상)
  INSERT INTO transactions (tenant_id, customer_id, source, type, method, amount, vat_type, transaction_date, order_id, description)
  VALUES (p_tenant_id, p_customer_id, 'shipment', 'receivable', v_orig.payment_method, -v_total_amount, 'supply', CURRENT_DATE, v_new_order_id, '미송해제');
  IF v_neg_vat > 0 THEN
    INSERT INTO transactions (tenant_id, customer_id, source, type, method, amount, vat_type, transaction_date, order_id, description)
    VALUES (p_tenant_id, p_customer_id, 'shipment', 'receivable', v_orig.payment_method, -v_neg_vat, 'vat', CURRENT_DATE, v_new_order_id, '미송해제');
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


-- ── 8) process_return_derived — 음수 supply / vat 행 (원영수증 박제 비례) ──
DROP FUNCTION IF EXISTS process_return_derived(UUID, UUID, JSONB, TEXT);

CREATE OR REPLACE FUNCTION process_return_derived(
  p_tenant_id UUID, p_order_id UUID, p_items JSONB, p_reason TEXT DEFAULT 'return'
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
  v_orig_supply      NUMERIC;
  v_orig_vat         NUMERIC;
  v_orig_vat_in_payment BOOLEAN;
  v_neg_vat          BIGINT := 0;
  v_vat_rate         NUMERIC;
BEGIN
  PERFORM assert_tenant_access(p_tenant_id);
  IF p_items IS NULL OR jsonb_array_length(p_items) = 0 THEN
    RETURN json_build_object('success', false, 'error', '항목이 비어있습니다.');
  END IF;
  IF p_reason NOT IN ('return', 'exchange') THEN
    RETURN json_build_object('success', false, 'error', 'p_reason 은 return 또는 exchange 만 허용');
  END IF;
  v_label := CASE p_reason WHEN 'exchange' THEN '교환반품' ELSE '반품' END;

  SELECT customer_id, customer_name, payment_method, order_number, order_type,
         receipt_supply_amount, receipt_vat_amount, receipt_vat_in_payment, vat_amount AS orig_vat_amount
  INTO v_orig FROM orders WHERE id = p_order_id AND tenant_id = p_tenant_id;
  IF NOT FOUND THEN RETURN json_build_object('success', false, 'error', '원 주문을 찾을 수 없습니다.'); END IF;

  v_orig_supply := COALESCE(v_orig.receipt_supply_amount, 0);
  v_orig_vat    := COALESCE(v_orig.receipt_vat_amount, 0);
  v_orig_vat_in_payment := COALESCE(v_orig.receipt_vat_in_payment, COALESCE(v_orig.orig_vat_amount, 0) > 0);

  SELECT outstanding_balance INTO v_balance_before FROM customers WHERE id = v_orig.customer_id;
  SELECT COALESCE(vat_rate, 0.10) INTO v_vat_rate FROM tenants WHERE id = p_tenant_id;

  v_new_order_number := v_orig.order_number || '-RT' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 4);

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
  ) RETURNING id INTO v_new_order_id;

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

  -- P1 박제 원칙: 원영수증 박제값 비례. receipt_supply_amount=0 fallback (이전 주문) 시 vat_rate 직접
  IF v_orig_supply > 0 THEN
    v_neg_vat := ROUND(v_total * v_orig_vat / v_orig_supply)::BIGINT;
  ELSE
    v_neg_vat := ROUND(v_total * v_vat_rate)::BIGINT;
  END IF;

  UPDATE orders
  SET total_amount = -v_total,
      vat_amount = CASE WHEN v_orig_vat_in_payment THEN -v_neg_vat ELSE 0 END,
      outstanding_amount = -v_total,
      sales_qty = -v_qty, revenue = -v_total, confirmed_amount = -v_total, order_qty = v_qty
  WHERE id = v_new_order_id;

  UPDATE customers
  SET outstanding_balance = outstanding_balance - v_total,
      outstanding_vat     = outstanding_vat - v_neg_vat
  WHERE id = v_orig.customer_id AND tenant_id = p_tenant_id;

  -- return 행 분리 박제 (vat 행 항상)
  INSERT INTO transactions (tenant_id, customer_id, source, type, method, amount, vat_type, transaction_date, order_id, description)
  VALUES (p_tenant_id, v_orig.customer_id, 'return', 'income', v_orig.payment_method, v_total, 'supply', CURRENT_DATE, v_new_order_id, v_label);
  IF v_neg_vat > 0 THEN
    INSERT INTO transactions (tenant_id, customer_id, source, type, method, amount, vat_type, transaction_date, order_id, description)
    VALUES (p_tenant_id, v_orig.customer_id, 'return', 'income', v_orig.payment_method, v_neg_vat, 'vat', CURRENT_DATE, v_new_order_id, v_label);
  END IF;

  PERFORM issue_receipt_snapshot(v_new_order_id, v_balance_before);

  RETURN json_build_object(
    'success', true, 'new_order_id', v_new_order_id,
    'new_order_number', v_new_order_number, 'amount', -v_total, 'count', v_qty
  );
END;
$$;

GRANT EXECUTE ON FUNCTION process_return_derived(UUID, UUID, JSONB, TEXT) TO authenticated;


-- ── 9) convert_samples_bulk — vat 행 항상 INSERT (vat 토글 무관) ──
CREATE OR REPLACE FUNCTION convert_samples_bulk(
  p_order_item_ids JSONB, p_tenant_id UUID
) RETURNS JSON LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_ids              UUID[];
  v_first            RECORD;
  v_item             RECORD;
  v_total            NUMERIC := 0;
  v_qty              INT     := 0;
  v_new_order_id     UUID;
  v_new_order_number TEXT;
  v_count            INT     := 0;
  v_id               UUID;
  v_balance_before   NUMERIC := 0;
  v_old_vat_balance  NUMERIC := 0;
  v_credit_supply    NUMERIC := 0;
  v_credit_vat       NUMERIC := 0;
  v_vat_rate         NUMERIC;
  v_include_vat      BOOLEAN;
  v_vat              BIGINT := 0;
  v_orders_vat       NUMERIC;
BEGIN
  IF p_order_item_ids IS NULL OR jsonb_array_length(p_order_item_ids) = 0 THEN
    RETURN json_build_object('success', false, 'error', '항목이 비어있습니다.');
  END IF;

  SELECT array_agg(value::TEXT::UUID) INTO v_ids
  FROM jsonb_array_elements_text(p_order_item_ids) AS value;

  SELECT
    oi.id, oi.is_sample, oi.sample_status,
    o.customer_id, o.customer_name, o.payment_method, o.order_number, o.order_type
  INTO v_first
  FROM order_items oi JOIN orders o ON o.id = oi.order_id
  WHERE oi.id = v_ids[1] AND o.tenant_id = p_tenant_id;
  IF NOT FOUND THEN RETURN json_build_object('success', false, 'error', '첫 항목을 찾을 수 없습니다.'); END IF;

  FOR v_item IN
    SELECT oi.id, oi.is_sample, oi.sample_status, oi.quantity, oi.unit_price, o.customer_id
    FROM order_items oi JOIN orders o ON o.id = oi.order_id
    WHERE oi.id = ANY(v_ids) AND o.tenant_id = p_tenant_id
  LOOP
    IF NOT v_item.is_sample THEN RETURN json_build_object('success', false, 'error', '샘플이 아닌 항목 포함'); END IF;
    IF v_item.sample_status <> 'pending' THEN RETURN json_build_object('success', false, 'error', '이미 처리된 샘플 포함'); END IF;
    IF v_item.customer_id <> v_first.customer_id THEN RETURN json_build_object('success', false, 'error', '서로 다른 거래처 항목 혼합'); END IF;
    v_total := v_total + (v_item.quantity * v_item.unit_price);
    v_qty   := v_qty + v_item.quantity;
    v_count := v_count + 1;
  END LOOP;
  IF v_count <> array_length(v_ids, 1) THEN RETURN json_build_object('success', false, 'error', '일부 항목을 찾을 수 없습니다.'); END IF;

  UPDATE order_items SET sample_status = 'converted', updated_at = NOW() WHERE id = ANY(v_ids);

  SELECT COALESCE(outstanding_balance, 0), COALESCE(outstanding_vat, 0), COALESCE(include_vat, true)
  INTO v_balance_before, v_old_vat_balance, v_include_vat
  FROM customers WHERE id = v_first.customer_id AND tenant_id = p_tenant_id;

  SELECT COALESCE(vat_rate, 0.10) INTO v_vat_rate FROM tenants WHERE id = p_tenant_id;
  -- vat 행 amount = 항상 (ledger 박제용)
  v_vat := ROUND(v_total * v_vat_rate)::BIGINT;
  -- orders.vat_amount = 거래처 include_vat 따름 (영수증 vat_in_payment 결정자)
  v_orders_vat := CASE WHEN v_include_vat THEN v_vat ELSE 0 END;

  v_new_order_number := v_first.order_number || '-S' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 4);

  INSERT INTO orders (
    tenant_id, customer_id, customer_name, order_number, order_type,
    order_source, status, total_amount, vat_amount, paid_amount, outstanding_amount,
    payment_method, payment_status,
    sales_qty, revenue, confirmed_amount, order_qty,
    is_processed, has_pending, memo
  ) VALUES (
    p_tenant_id, v_first.customer_id, v_first.customer_name, v_new_order_number,
    COALESCE(v_first.order_type, 'wholesale'),
    'sample_convert', 'shipped',
    v_total + v_orders_vat, v_orders_vat, 0, v_total,
    v_first.payment_method, 'unpaid',
    v_qty, v_total, v_total, v_qty,
    TRUE, FALSE,
    '샘플 매입 전환 묶음 (' || v_count || '건)'
  ) RETURNING id INTO v_new_order_id;

  FOREACH v_id IN ARRAY v_ids
  LOOP
    SELECT variant_id, quantity, unit_price INTO v_item FROM order_items WHERE id = v_id;
    INSERT INTO order_items (
      order_id, variant_id, quantity, original_quantity, remaining_qty,
      unit_price, total_price, status, process_type,
      shipped_qty, shipped_at, is_sample, is_exchange,
      sample_status, sample_due_date
    ) VALUES (
      v_new_order_id, v_item.variant_id, v_item.quantity, v_item.quantity, 0,
      v_item.unit_price, v_item.quantity * v_item.unit_price, 'shipped', 'ordered',
      v_item.quantity, NOW(), FALSE, FALSE, NULL, NULL
    );
  END LOOP;

  -- shipment 행 분리 (vat 행 항상)
  INSERT INTO transactions (tenant_id, customer_id, source, type, method, amount, vat_type, transaction_date, order_id)
  VALUES (p_tenant_id, v_first.customer_id, 'shipment', 'receivable', v_first.payment_method, v_total, 'supply', CURRENT_DATE, v_new_order_id);
  IF v_vat > 0 THEN
    INSERT INTO transactions (tenant_id, customer_id, source, type, method, amount, vat_type, transaction_date, order_id)
    VALUES (p_tenant_id, v_first.customer_id, 'shipment', 'receivable', v_first.payment_method, v_vat, 'vat', CURRENT_DATE, v_new_order_id);
  END IF;

  UPDATE customers
  SET outstanding_balance = COALESCE(outstanding_balance, 0) + v_total,
      outstanding_vat     = COALESCE(outstanding_vat, 0) + v_vat
  WHERE id = v_first.customer_id AND tenant_id = p_tenant_id;

  -- 매입금 충당 (supply / vat 분리)
  IF v_balance_before < 0 THEN
    v_credit_supply := LEAST(ABS(v_balance_before)::BIGINT, v_total);
    UPDATE orders
    SET paid_amount        = COALESCE(paid_amount, 0) + v_credit_supply,
        outstanding_amount = GREATEST(0, outstanding_amount - v_credit_supply),
        payment_status     = CASE
          WHEN GREATEST(0, outstanding_amount - v_credit_supply) = 0 THEN 'paid'
          WHEN COALESCE(paid_amount, 0) + v_credit_supply > 0 THEN 'partial'
          ELSE payment_status END
    WHERE id = v_new_order_id;
    INSERT INTO transactions (tenant_id, customer_id, source, type, method, amount, vat_type, transaction_date, order_id, description)
    VALUES (p_tenant_id, v_first.customer_id, 'credit_apply', 'income', NULL, v_credit_supply, 'supply', CURRENT_DATE, v_new_order_id, '매입금 자동 충당 (공급가)');
  END IF;
  IF v_old_vat_balance < 0 AND v_vat > 0 THEN
    v_credit_vat := LEAST(ABS(v_old_vat_balance)::BIGINT, v_vat);
    INSERT INTO transactions (tenant_id, customer_id, source, type, method, amount, vat_type, transaction_date, order_id, description)
    VALUES (p_tenant_id, v_first.customer_id, 'credit_apply', 'income', NULL, v_credit_vat, 'vat', CURRENT_DATE, v_new_order_id, '매입금 자동 충당 (부가세)');
  END IF;

  PERFORM issue_receipt_snapshot(v_new_order_id, v_balance_before);

  RETURN json_build_object(
    'success', true, 'new_order_id', v_new_order_id,
    'new_order_number', v_new_order_number, 'amount', v_total, 'count', v_count
  );
END;
$$;

GRANT EXECUTE ON FUNCTION convert_samples_bulk(JSONB, UUID) TO authenticated;


-- ── 10) 일괄 재계산 (vat_type 별) ──
UPDATE customers c SET
  outstanding_balance = (
    SELECT COALESCE(SUM(CASE
      WHEN source IN ('shipment', 'refund') THEN amount
      WHEN source IN ('return', 'payment', 'credit_apply', 'purchase') THEN -amount
      ELSE 0
    END), 0)
    FROM transactions WHERE customer_id = c.id AND vat_type = 'supply'
  ),
  outstanding_vat = (
    SELECT COALESCE(SUM(CASE
      WHEN source IN ('shipment', 'refund') THEN amount
      WHEN source IN ('return', 'payment', 'credit_apply', 'purchase', 'vat_collection') THEN -amount
      ELSE 0
    END), 0)
    FROM transactions WHERE customer_id = c.id AND vat_type = 'vat'
  );

UPDATE orders o SET outstanding_amount = (
  SELECT COALESCE(SUM(CASE
    WHEN source IN ('shipment', 'refund') THEN amount
    WHEN source IN ('return', 'payment', 'credit_apply', 'purchase') THEN -amount
    ELSE 0
  END), 0)
  FROM transactions WHERE order_id = o.id AND vat_type = 'supply'
)
WHERE EXISTS (SELECT 1 FROM transactions WHERE order_id = o.id);

NOTIFY pgrst, 'reload schema';
