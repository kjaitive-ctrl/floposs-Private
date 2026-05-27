-- ============================================================
-- 058: 교환(exchange) 플래그 — 재정 계산에서 제외
--
-- 문제: restore_inventory로 order_item이 backorder+unshipped로 바뀌면
--       trg_order_items_revenue 트리거 → refresh_order_revenue 발동
--       → 교환 항목이 revenue에 포함 → 외상 증가 (잘못된 동작)
--
-- 해결: order_items.is_exchange=true 항목은 revenue 계산에서 제외
-- ============================================================

-- 1. order_items에 is_exchange 컬럼 추가
ALTER TABLE order_items
  ADD COLUMN IF NOT EXISTS is_exchange BOOLEAN NOT NULL DEFAULT FALSE;

-- 2. restore_inventory: p_is_exchange 파라미터 추가
CREATE OR REPLACE FUNCTION public.restore_inventory(
  p_tenant_id         UUID,
  p_variant_id        UUID,
  p_qty               INT,
  p_order_item_id     UUID    DEFAULT NULL,
  p_restore_remaining BOOLEAN DEFAULT TRUE,
  p_process_type      TEXT    DEFAULT NULL,
  p_reason            TEXT    DEFAULT 'receipt',
  p_is_exchange       BOOLEAN DEFAULT FALSE
)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_new_inv_qty INT;
BEGIN
  UPDATE inventory
  SET quantity   = quantity + p_qty,
      updated_at = NOW()
  WHERE tenant_id  = p_tenant_id
    AND variant_id = p_variant_id
  RETURNING quantity INTO v_new_inv_qty;

  IF p_order_item_id IS NOT NULL THEN
    UPDATE order_items
    SET shipped_qty   = GREATEST(0, shipped_qty - p_qty),
        remaining_qty = CASE
                          WHEN p_restore_remaining
                          THEN LEAST(remaining_qty + p_qty, COALESCE(original_quantity, remaining_qty + p_qty))
                          ELSE remaining_qty
                        END,
        status        = CASE
                          WHEN p_restore_remaining AND status = 'shipped' THEN 'unshipped'
                          ELSE status
                        END,
        process_type  = CASE
                          WHEN p_restore_remaining AND p_process_type IS NOT NULL THEN p_process_type
                          ELSE process_type
                        END,
        is_exchange   = p_is_exchange
    WHERE id = p_order_item_id;
  END IF;

  INSERT INTO inventory_logs
    (tenant_id, variant_id, order_item_id, qty_change, balance_after, reason)
  VALUES
    (p_tenant_id, p_variant_id, p_order_item_id, p_qty, COALESCE(v_new_inv_qty, 0), p_reason);
END;
$$;

-- 3. refresh_order_revenue: is_exchange=true 항목은 revenue 계산 제외
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
    -- sales_qty: 출고된 수량 + 미송 잔량 (교환 제외)
    COALESCE(SUM(shipped_qty), 0)
      + COALESCE(SUM(CASE WHEN process_type = 'backorder' AND status = 'unshipped' AND NOT COALESCE(is_exchange, FALSE)
                          THEN remaining_qty ELSE 0 END), 0),
    -- revenue: 출고 금액 + 미송 잔량 금액 (교환 제외)
    COALESCE(SUM(shipped_qty * unit_price), 0)
      + COALESCE(SUM(CASE WHEN process_type = 'backorder' AND status = 'unshipped' AND NOT COALESCE(is_exchange, FALSE)
                          THEN remaining_qty * unit_price ELSE 0 END), 0),
    -- confirmed_amount: 출고 + 미송/보류 잔량 (교환 제외)
    COALESCE(SUM(shipped_qty * unit_price), 0)
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
        AND NOT COALESCE(is_exchange, FALSE)
    )
  INTO v_sales_qty, v_revenue, v_confirmed_amount, v_order_qty, v_is_processed, v_has_pending
  FROM order_items
  WHERE order_id = p_order_id;

  -- 배치 출고 증분 계산
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

  -- 최초 처리 전환 시 receivable 생성
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

  -- 배치 출고 증분 receivable 생성
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
