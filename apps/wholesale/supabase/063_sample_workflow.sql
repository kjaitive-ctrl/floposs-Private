-- ============================================================
-- 063: 샘플 제공 워크플로우
--
-- 1) order_items에 샘플 관련 컬럼 추가
--    - is_sample          : 샘플 라인 여부
--    - sample_status      : 'pending' | 'returned' | 'converted'
--    - sample_due_date    : 반환 기한 (출고/주문 시점 기준 + sample_period_days)
-- 2) refresh_order_revenue: is_sample=true 라인 매출 계산 제외
--    (is_exchange와 동일 패턴)
-- 3) process_sample_return : 샘플 반환 처리 (재고 복원)
-- 4) process_sample_convert: 샘플 → 정상 판매 전환 (매출 발생)
-- ============================================================

ALTER TABLE order_items
  ADD COLUMN IF NOT EXISTS is_sample        BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS sample_status    TEXT,
  ADD COLUMN IF NOT EXISTS sample_due_date  DATE;

ALTER TABLE order_items DROP CONSTRAINT IF EXISTS order_items_sample_status_check;
ALTER TABLE order_items ADD CONSTRAINT order_items_sample_status_check
  CHECK (sample_status IS NULL OR sample_status IN ('pending', 'returned', 'converted'));

CREATE INDEX IF NOT EXISTS idx_order_items_active_samples
  ON order_items (sample_status, sample_due_date)
  WHERE is_sample = TRUE AND sample_status = 'pending';


-- ── refresh_order_revenue: is_sample 라인 매출 제외 ─────────
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

  SELECT outstanding_balance INTO v_old_balance
  FROM customers WHERE id = v_customer_id AND tenant_id = v_tenant_id;

  -- is_exchange OR is_sample 인 라인은 매출 계산에서 모두 제외
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
        AND NOT COALESCE(is_sample, FALSE)
    ),
    EXISTS (
      SELECT 1 FROM order_items
      WHERE order_id = p_order_id
        AND process_type IN ('backorder', 'hold')
        AND status = 'unshipped'
        AND NOT COALESCE(is_sample, FALSE)
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


-- ── 샘플 반환 처리 ───────────────────────────────────────────
-- 샘플 라인을 returned 상태로 마킹 + 재고 복원
CREATE OR REPLACE FUNCTION process_sample_return(
  p_order_item_id UUID,
  p_tenant_id     UUID
) RETURNS JSON LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_item RECORD;
BEGIN
  SELECT oi.id, oi.variant_id, oi.quantity, oi.is_sample, oi.sample_status
  INTO v_item
  FROM order_items oi
  JOIN orders o ON o.id = oi.order_id
  WHERE oi.id = p_order_item_id AND o.tenant_id = p_tenant_id;

  IF NOT FOUND THEN
    RETURN json_build_object('success', false, 'error', '항목을 찾을 수 없습니다.');
  END IF;
  IF NOT v_item.is_sample THEN
    RETURN json_build_object('success', false, 'error', '샘플 항목이 아닙니다.');
  END IF;
  IF v_item.sample_status <> 'pending' THEN
    RETURN json_build_object('success', false, 'error', '이미 처리된 샘플입니다.');
  END IF;

  UPDATE order_items
  SET sample_status = 'returned',
      updated_at    = NOW()
  WHERE id = p_order_item_id;

  UPDATE inventory
  SET quantity   = quantity + v_item.quantity,
      updated_at = NOW()
  WHERE tenant_id = p_tenant_id AND variant_id = v_item.variant_id;

  RETURN json_build_object('success', true);
END;
$$;


-- ── 샘플 → 정상 판매 전환 ─────────────────────────────────────
-- is_sample 해제 + sample_status='converted'
-- → refresh_order_revenue 트리거가 자동으로 매출/외상 갱신
CREATE OR REPLACE FUNCTION process_sample_convert(
  p_order_item_id UUID,
  p_tenant_id     UUID
) RETURNS JSON LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_item    RECORD;
  v_order_id UUID;
BEGIN
  SELECT oi.id, oi.order_id, oi.is_sample, oi.sample_status
  INTO v_item
  FROM order_items oi
  JOIN orders o ON o.id = oi.order_id
  WHERE oi.id = p_order_item_id AND o.tenant_id = p_tenant_id;

  IF NOT FOUND THEN
    RETURN json_build_object('success', false, 'error', '항목을 찾을 수 없습니다.');
  END IF;
  IF NOT v_item.is_sample THEN
    RETURN json_build_object('success', false, 'error', '샘플 항목이 아닙니다.');
  END IF;
  IF v_item.sample_status <> 'pending' THEN
    RETURN json_build_object('success', false, 'error', '이미 처리된 샘플입니다.');
  END IF;

  v_order_id := v_item.order_id;

  UPDATE order_items
  SET is_sample      = FALSE,
      sample_status  = 'converted',
      updated_at     = NOW()
  WHERE id = p_order_item_id;

  -- 매출/외상 갱신 (trigger가 발동 안 될 수 있어 명시 호출)
  PERFORM refresh_order_revenue(v_order_id);

  RETURN json_build_object('success', true);
END;
$$;
