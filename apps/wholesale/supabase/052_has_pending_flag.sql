-- ============================================================
-- 052: orders.has_pending — 미송/보류 항목 존재 여부
-- ============================================================

ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS has_pending BOOLEAN NOT NULL DEFAULT FALSE;

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
  v_tenant_id        UUID;
  v_customer_id      UUID;
  v_payment_method   TEXT;
  v_payment_status   TEXT;
BEGIN
  SELECT is_processed, tenant_id, customer_id, payment_method, payment_status
  INTO v_prev_processed, v_tenant_id, v_customer_id, v_payment_method, v_payment_status
  FROM orders WHERE id = p_order_id;

  SELECT
    COALESCE(SUM(shipped_qty), 0)
      + COALESCE(SUM(CASE WHEN process_type = 'backorder' AND status = 'unshipped'
                          THEN remaining_qty ELSE 0 END), 0),
    COALESCE(SUM(shipped_qty * unit_price), 0)
      + COALESCE(SUM(CASE WHEN process_type = 'backorder' AND status = 'unshipped'
                          THEN remaining_qty * unit_price ELSE 0 END), 0),
    COALESCE(SUM(shipped_qty * unit_price), 0)
      + COALESCE(SUM(CASE WHEN process_type IN ('backorder', 'hold') AND status = 'unshipped'
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

  UPDATE orders
  SET sales_qty        = v_sales_qty,
      revenue          = v_revenue,
      confirmed_amount = v_confirmed_amount,
      order_qty        = v_order_qty,
      is_processed     = v_is_processed,
      has_pending      = v_has_pending,
      outstanding_amount = CASE
        WHEN v_is_processed AND NOT v_prev_processed AND v_payment_status = 'unpaid'
        THEN v_revenue
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
END;
$$;

-- 기존 데이터 backfill
UPDATE orders
SET has_pending = EXISTS (
  SELECT 1 FROM order_items
  WHERE order_id = orders.id
    AND process_type IN ('backorder', 'hold')
    AND status = 'unshipped'
);
