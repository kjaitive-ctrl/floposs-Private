-- ============================================================
-- 061: 출고 시 매입금(크레딧) 자동 충당
--
-- 배경:
--   거래처 outstanding_balance가 음수(=매입, 우리가 줄 돈)인 상태에서
--   새 주문이 출고되면, receivable이 추가되며 잔액이 0/+로 회복됨.
--   하지만 새 주문의 paid_amount는 0으로 유지되어 "미결제" 상태가 됨.
--   → 거래처 잔액(=정산됨)과 주문 결제 상태(=미결제)가 어긋남.
--
-- 해결:
--   refresh_order_revenue가 receivable을 생성한 직후, 거래처 잔액이
--   음수였다면 그 크레딧만큼 새 주문의 paid_amount에 자동 충당.
--   감사용 transactions(source='credit_apply') 행을 추가로 기록.
--
-- 참고: 060_exchange_exclude_shipped.sql 의 refresh_order_revenue 를
--       그대로 복제하고, 두 군데(최초 처리/증분)에 충당 로직 추가.
-- ============================================================

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
BEGIN
  SELECT is_processed, tenant_id, customer_id, payment_method, payment_status, revenue
  INTO v_prev_processed, v_tenant_id, v_customer_id, v_payment_method, v_payment_status, v_prev_revenue
  FROM orders WHERE id = p_order_id;

  -- 출고 전 거래처 잔액 스냅샷 (자동 충당 판단용)
  SELECT outstanding_balance INTO v_old_balance
  FROM customers WHERE id = v_customer_id AND tenant_id = v_tenant_id;

  SELECT
    -- sales_qty: 교환 항목 완전 제외
    COALESCE(SUM(CASE WHEN NOT COALESCE(is_exchange, FALSE) THEN shipped_qty ELSE 0 END), 0)
      + COALESCE(SUM(CASE WHEN process_type = 'backorder' AND status = 'unshipped' AND NOT COALESCE(is_exchange, FALSE)
                          THEN remaining_qty ELSE 0 END), 0),
    -- revenue: 교환 항목 완전 제외
    COALESCE(SUM(CASE WHEN NOT COALESCE(is_exchange, FALSE) THEN shipped_qty * unit_price ELSE 0 END), 0)
      + COALESCE(SUM(CASE WHEN process_type = 'backorder' AND status = 'unshipped' AND NOT COALESCE(is_exchange, FALSE)
                          THEN remaining_qty * unit_price ELSE 0 END), 0),
    -- confirmed_amount: 교환 항목 완전 제외
    COALESCE(SUM(CASE WHEN NOT COALESCE(is_exchange, FALSE) THEN shipped_qty * unit_price ELSE 0 END), 0)
      + COALESCE(SUM(CASE WHEN process_type IN ('backorder', 'hold') AND status = 'unshipped' AND NOT COALESCE(is_exchange, FALSE)
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
      payment_status   = CASE
        WHEN v_increment > 0 THEN 'unpaid'
        ELSE payment_status
      END,
      outstanding_amount = CASE
        WHEN v_is_processed AND NOT v_prev_processed AND v_payment_status = 'unpaid'
        THEN v_revenue
        WHEN v_increment > 0
        THEN outstanding_amount + v_increment
        ELSE outstanding_amount
      END
  WHERE id = p_order_id;

  -- ── 최초 출고 처리 ──────────────────────────────────────────
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

    -- 매입금 자동 충당
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
  END IF;

  -- ── 증분 출고 (배치 추가) ────────────────────────────────────
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

    -- 매입금 자동 충당 (증분분에 대해)
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
