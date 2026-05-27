-- ============================================================
-- 108: 영수증 v2 Phase 3 — 영수증 박제 통합
--
-- 사장 모델 (회의 2026-05-03):
--   영수증 박제 5종 (전잔/당일/결제수단/결제액/당잔) + 발행번호/시점.
--   박제 = 영수증 발행 시점 1회. 재발행 시 print_count 만 증가.
--
-- 박제 시점:
--   - 일반 주문: refresh_order_revenue 의 "첫 처리" 분기에서 (등록 후 처리 완료 시점)
--   - derived 주문: process_pending_ship 끝에서 (미송/보류 출고 시점)
--
-- prev/post balance 계산:
--   - 호출자가 시작/끝 customers.outstanding_balance snapshot 후 인자로 전달
--   - issue_receipt_snapshot 가 받아 박제 (단순 박제 함수, 계산 X)
--
-- idempotent: 이미 receipt_no IS NOT NULL 이면 SKIP.
-- ============================================================

-- ── 1) issue_receipt_snapshot: 단순 박제 함수 ────────────────
CREATE OR REPLACE FUNCTION issue_receipt_snapshot(
  p_order_id     UUID,
  p_prev_balance NUMERIC,
  p_post_balance NUMERIC
)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_order          RECORD;
  v_payment_method TEXT;
  v_receipt_no     TEXT;
  v_seq            INT;
BEGIN
  SELECT id, tenant_id, customer_id, total_amount, payment_method, receipt_no
  INTO v_order FROM orders WHERE id = p_order_id;

  IF NOT FOUND THEN RETURN; END IF;
  IF v_order.receipt_no IS NOT NULL THEN RETURN; END IF;  -- idempotent

  -- 결제수단: 거래처 기본 (없으면 주문의 payment_method 폴백)
  SELECT default_payment_method INTO v_payment_method
  FROM customers WHERE id = v_order.customer_id;
  v_payment_method := COALESCE(v_payment_method, v_order.payment_method, 'cash');

  -- 영수증 번호: R + YYYYMMDD + 4자리 시퀀스 (tenant 내 일자별)
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
    receipt_day_total       = v_order.total_amount,
    receipt_payment_method  = v_payment_method,
    receipt_payment_amount  = v_order.total_amount,
    receipt_post_balance    = p_post_balance
  WHERE id = p_order_id;
END;
$$;

GRANT EXECUTE ON FUNCTION issue_receipt_snapshot(UUID, NUMERIC, NUMERIC) TO authenticated;


-- ── 2) process_pending_ship: 박제 통합 ───────────────────────
-- (105 의 RPC 본문 + 시작/끝 balance snapshot + 영수증 박제 호출 추가)
CREATE OR REPLACE FUNCTION process_pending_ship(
  p_tenant_id          UUID,
  p_original_order_id  UUID,
  p_item_qty           JSONB
)
RETURNS UUID LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_orig             RECORD;
  v_new_order_id     UUID;
  v_new_order_number TEXT;
  v_total            NUMERIC := 0;
  v_qty              INT     := 0;
  v_revenue          NUMERIC := 0;
  v_sales_qty        INT     := 0;
  v_payload          JSONB;
  v_item             RECORD;
  v_qty_to_ship      INT;
  v_balance_before   NUMERIC;
  v_balance_after    NUMERIC;
BEGIN
  PERFORM assert_tenant_access(p_tenant_id);

  SELECT customer_id, customer_name, payment_method, order_number, order_type
  INTO v_orig
  FROM orders WHERE id = p_original_order_id AND tenant_id = p_tenant_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION '원본 주문을 찾을 수 없습니다 (%)', p_original_order_id
      USING ERRCODE = 'P0001';
  END IF;

  -- 영수증 prev_balance 용 시작 시점 외상 snapshot
  SELECT outstanding_balance INTO v_balance_before
  FROM customers WHERE id = v_orig.customer_id;

  -- 1) 각 item 처리: 재고 차감 + 원본 order_item 업데이트
  FOR v_payload IN SELECT * FROM jsonb_array_elements(p_item_qty)
  LOOP
    v_qty_to_ship := (v_payload->>'qty')::INT;

    SELECT id, variant_id, unit_price, remaining_qty, process_type, is_sample, is_exchange
    INTO v_item
    FROM order_items WHERE id = (v_payload->>'item_id')::UUID;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'order_item 을 찾을 수 없습니다 (%)', v_payload->>'item_id'
        USING ERRCODE = 'P0001';
    END IF;
    IF v_item.process_type NOT IN ('backorder', 'hold') THEN
      RAISE EXCEPTION '미송/보류 항목만 처리 가능. 받은: %', v_item.process_type
        USING ERRCODE = 'P0001';
    END IF;

    PERFORM deduct_inventory(
      p_tenant_id     := p_tenant_id,
      p_variant_id    := v_item.variant_id,
      p_qty           := v_qty_to_ship,
      p_order_item_id := v_item.id,
      p_close         := v_qty_to_ship >= v_item.remaining_qty
    );

    v_total := v_total + (v_qty_to_ship * v_item.unit_price);
    v_qty   := v_qty + v_qty_to_ship;

    -- 보류 출고분만 매출/판매 인식 (미송은 원본에서 이미 인식됨)
    IF v_item.process_type = 'hold' THEN
      v_revenue   := v_revenue + (v_qty_to_ship * v_item.unit_price);
      v_sales_qty := v_sales_qty + v_qty_to_ship;
    END IF;
  END LOOP;

  -- 2) 신규 derived 주문 생성
  v_new_order_number := v_orig.order_number || '-S'
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
    'pending_ship', 'shipped', v_orig.payment_method, 'unpaid',
    v_total, 0, 0, 0,
    p_original_order_id, true, false,
    v_sales_qty, v_revenue, v_revenue, v_qty,
    '미송/보류 출고 (원본: ' || v_orig.order_number || ')'
  )
  RETURNING id INTO v_new_order_id;

  -- 3) derived 주문에 출고된 항목 복사
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

  -- 4) 원본 주문 refresh — 보류 출고분이 있으면 외상 +X (매출/외상 자연 처리)
  PERFORM refresh_order_revenue(p_original_order_id);

  -- 5) 영수증 박제 — derived 주문에 prev/post balance 박제
  SELECT outstanding_balance INTO v_balance_after
  FROM customers WHERE id = v_orig.customer_id;
  PERFORM issue_receipt_snapshot(v_new_order_id, v_balance_before, v_balance_after);

  RETURN v_new_order_id;
END;
$$;

GRANT EXECUTE ON FUNCTION process_pending_ship(UUID, UUID, JSONB) TO authenticated;


-- ── 3) refresh_order_revenue: 첫 처리 시점에 영수증 박제 통합 ────
-- (107 본문 그대로 + 첫 처리 분기 끝에 issue_receipt_snapshot 호출 추가)
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
BEGIN
  -- 107 안전망: derived 주문 SKIP
  SELECT derived_from_order_id INTO v_derived_from
  FROM orders WHERE id = p_order_id;
  IF v_derived_from IS NOT NULL THEN RETURN; END IF;

  SELECT is_processed, tenant_id, customer_id, payment_method, payment_status, revenue
  INTO v_prev_processed, v_tenant_id, v_customer_id, v_payment_method, v_payment_status, v_prev_revenue
  FROM orders WHERE id = p_order_id;

  SELECT outstanding_balance INTO v_old_balance
  FROM customers WHERE id = v_customer_id AND tenant_id = v_tenant_id;

  SELECT
    COALESCE(SUM(CASE
      WHEN NOT COALESCE(is_exchange, FALSE) AND NOT COALESCE(is_sample, FALSE)
      THEN shipped_qty ELSE 0 END), 0)
      + COALESCE(SUM(CASE
          WHEN process_type = 'backorder' AND status = 'unshipped'
            AND NOT COALESCE(is_exchange, FALSE) AND NOT COALESCE(is_sample, FALSE)
          THEN remaining_qty ELSE 0 END), 0),
    COALESCE(SUM(CASE
      WHEN NOT COALESCE(is_exchange, FALSE) AND NOT COALESCE(is_sample, FALSE)
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
    NOT EXISTS (
      SELECT 1 FROM order_items
      WHERE order_id = p_order_id
        AND process_type = 'ordered'
        AND status = 'unshipped'
    ),
    EXISTS (
      SELECT 1 FROM order_items
      WHERE order_id = p_order_id
        AND process_type IN ('backorder', 'hold')
        AND status = 'unshipped'
    )
  INTO v_sales_qty, v_revenue, v_confirmed_amount, v_order_qty, v_is_processed, v_has_pending
  FROM order_items
  WHERE order_id = p_order_id;

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
      tenant_id, customer_id, source, type, method,
      amount, transaction_date, order_id
    ) VALUES (
      v_tenant_id, v_customer_id, 'shipment', 'receivable', v_payment_method,
      v_revenue, CURRENT_DATE, p_order_id
    );
    UPDATE customers
    SET outstanding_balance = outstanding_balance + v_revenue
    WHERE id = v_customer_id AND tenant_id = v_tenant_id;

    IF v_old_balance < 0 THEN
      v_credit_used := LEAST(ABS(v_old_balance)::BIGINT, v_revenue);
      UPDATE orders
      SET paid_amount        = COALESCE(paid_amount, 0) + v_credit_used,
          outstanding_amount = GREATEST(0, outstanding_amount - v_credit_used),
          payment_status     = CASE
            WHEN outstanding_amount - v_credit_used <= 0 THEN 'paid'
            WHEN v_credit_used > 0 THEN 'partial'
            ELSE payment_status
          END
      WHERE id = p_order_id;
      INSERT INTO transactions (
        tenant_id, customer_id, source, type, method,
        amount, transaction_date, order_id, description
      ) VALUES (
        v_tenant_id, v_customer_id, 'credit_apply', 'income', NULL,
        v_credit_used, CURRENT_DATE, p_order_id, '매입금 자동 충당'
      );
    END IF;

    -- 영수증 박제 (첫 처리 시점, idempotent — receipt_no 있으면 SKIP)
    PERFORM issue_receipt_snapshot(
      p_order_id,
      v_old_balance::NUMERIC,
      (v_old_balance + v_revenue)::NUMERIC
    );
  END IF;

  IF v_increment > 0 THEN
    INSERT INTO transactions (
      tenant_id, customer_id, source, type, method,
      amount, transaction_date, order_id
    ) VALUES (
      v_tenant_id, v_customer_id, 'shipment', 'receivable', v_payment_method,
      v_increment, CURRENT_DATE, p_order_id
    );
    UPDATE customers
    SET outstanding_balance = outstanding_balance + v_increment
    WHERE id = v_customer_id AND tenant_id = v_tenant_id;

    IF v_old_balance < 0 THEN
      v_credit_used := LEAST(ABS(v_old_balance)::BIGINT, v_increment);
      UPDATE orders
      SET paid_amount        = COALESCE(paid_amount, 0) + v_credit_used,
          outstanding_amount = GREATEST(0, outstanding_amount - v_credit_used),
          payment_status     = CASE
            WHEN outstanding_amount - v_credit_used <= 0 THEN 'paid'
            WHEN v_credit_used > 0 THEN 'partial'
            ELSE payment_status
          END
      WHERE id = p_order_id;
      INSERT INTO transactions (
        tenant_id, customer_id, source, type, method,
        amount, transaction_date, order_id, description
      ) VALUES (
        v_tenant_id, v_customer_id, 'credit_apply', 'income', NULL,
        v_credit_used, CURRENT_DATE, p_order_id, '매입금 자동 충당'
      );
    END IF;
  END IF;
END;
$$;
