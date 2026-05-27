-- ============================================================
-- 060: refresh_order_revenue — 교환 항목 출고 시 외상 생성 버그 수정
--
-- 문제: 교환 미송 항목을 출고하면 shipped_qty 증가
--       SUM(shipped_qty * unit_price) 에 is_exchange 제외가 없어서
--       revenue 증가 → 외상 생성
--
-- 해결: shipped_qty 기반 계산에도 is_exchange=true 제외
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
BEGIN
  SELECT is_processed, tenant_id, customer_id, payment_method, payment_status, revenue
  INTO v_prev_processed, v_tenant_id, v_customer_id, v_payment_method, v_payment_status, v_prev_revenue
  FROM orders WHERE id = p_order_id;

  SELECT
    -- sales_qty: 교환 항목 완전 제외 (출고 수량 + 미송 잔량)
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
    -- has_pending: 교환 포함 (UI 붉은색 표시용)
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
  END IF;
END;
$$;
