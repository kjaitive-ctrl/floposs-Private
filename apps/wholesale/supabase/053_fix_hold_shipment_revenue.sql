-- ============================================================
-- 053: refresh_order_revenue 보류(생산오더) 배치출고 버그 수정
--
-- 문제1: 보류 처리 시 is_processed=true로 전환되지만 revenue=0
--        이후 출고 시 이미 is_processed=true라 receivable 미생성
-- 문제2: 1차 배치 결제(payment_status='paid') 후
--        2차 배치 출고 시 paid 조건에 막혀 receivable 미생성
--
-- 해결: revenue 증가 시 무조건 증분 receivable 생성
--       + payment_status를 'unpaid'로 리셋 (다음 배치 결제 대기)
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
      -- 배치 출고 시 payment_status 리셋 (이전 배치 결제됐어도 새 배치 수금 대기)
      payment_status   = CASE
        WHEN v_increment > 0 THEN 'unpaid'
        ELSE payment_status
      END,
      outstanding_amount = CASE
        -- 최초 처리 전환
        WHEN v_is_processed AND NOT v_prev_processed AND v_payment_status = 'unpaid'
        THEN v_revenue
        -- 배치 출고 증분
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

  -- 배치 출고 증분 receivable 생성 (결제 완료 여부 무관)
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
