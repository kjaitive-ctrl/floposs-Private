-- ============================================================
-- 139: 영수증 박제 조건 = 실제 출고 발생 시 (shipped_qty > 0)
--
-- 사장 정책 정리 (2026-05-06):
--   영수증 = 실물 출고 시점에만 발행. 보류/미송 등록(분류 변경)만으로는 X.
--   - 보류 처리 = 단순 pending. 영수증 X.
--   - 미송 처리 = 매출/외상 인식 O 이지만 영수증 X (등록만, 실물 안 움직임).
--   - 출고 (shipped_qty > 0) 시점에만 영수증 발행.
--
-- 138 회귀:
--   138 가 "첫 처리 시 항상 영수증 박제" 로 변경 → 보류/미송 등록만 해도 발행.
--   사장 발견: ordered → hold 처리 시 영수증 + hold → 출고 시 또 영수증 = 2장.
--   샘플뿐만 아니라 일반 주문도 동일 버그.
--
-- 변경:
--   refresh_order_revenue 의 영수증 박제 분기에 v_has_shipped 검사 추가.
--   shipped_qty > 0 인 라인이 있어야 영수증 박제.
--
-- 결과 매트릭스:
--   - 일반 [당일] 출고: shipped_qty>0 → 영수증 O ✓
--   - [보류] 등록만: shipped_qty=0 → 영수증 X ✓
--   - [미송] 등록만: shipped_qty=0 → 영수증 X (매출/외상은 인식)
--   - 샘플 [당일] 직접 출고: shipped_qty>0 → 영수증 O (양식 = 샘플 전표) ✓
--   - 보류/미송 → 출고: process_pending_ship 가 derived 발행 + 영수증 (139 무관) ✓
--
-- 매출/외상 분기 (v_revenue > 0): 그대로 — 미송 등록 시 매출/외상 인식.
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
  v_derived_from     UUID;
  v_has_shipped      BOOLEAN;
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

  -- 실제 출고된 라인 존재 여부 (139 신규).
  -- 영수증은 출고 시점에만 발행. 보류/미송 등록만으로는 영수증 X.
  SELECT EXISTS (
    SELECT 1 FROM order_items
    WHERE order_id = p_order_id AND shipped_qty > 0
  ) INTO v_has_shipped;

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

  -- 매출/외상/transactions 박제 — v_revenue > 0 일 때 (회계 인식)
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
  END IF;

  -- 영수증 박제 — 첫 처리 시 + 실제 출고 발생 (shipped_qty > 0) 시.
  -- 사장 정책 (2026-05-06): 영수증 = 실물 출고 시점만. 보류/미송 등록은 X.
  IF v_is_processed AND NOT v_prev_processed AND v_has_shipped THEN
    PERFORM issue_receipt_snapshot(p_order_id, v_old_balance::NUMERIC);
  END IF;

  -- v_increment 분기 (그대로)
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

NOTIFY pgrst, 'reload schema';
