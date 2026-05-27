-- ============================================================
-- 085: 박제된 RPC 들에 JWT cross-tenant 가드 일괄 적용
--
-- 적용 대상 (각 함수 최신 본문 + PERFORM assert_*_access(...)):
--   restore_inventory          (058)
--   process_backorder_release  (054)
--   process_return_item        (056)
--   process_undo_shipment      (054)
--   process_sample_return      (063)
--   process_sample_convert     (067)
--   refresh_order_revenue      (064)  → assert_order_tenant_access
--   get_dashboard_kpi          (012)
--   undo_day_payment           (051)
--   process_ship_item          (015)  -- 코드 미사용 legacy
--   reverse_ship_item          (015)  -- 코드 미사용 legacy
--   refresh_biz_session_stats  (075)  → assert_biz_session_tenant_access
--   settle_biz_session         (075)  → assert_biz_session_tenant_access
--
-- 본문은 각 원본 마이그레이션의 최신 정의를 그대로 사용.
-- 가드 한 줄만 BEGIN 직후 추가.
--
-- 주의: 트리거에서 호출되는 refresh_order_revenue 도 가드 적용됨 →
--   트리거 발동 컨텍스트(=클라이언트 INSERT/UPDATE)에서 auth.jwt() 가
--   살아있으므로 정상 통과. super_admin 은 모든 tenant bypass.
-- ============================================================


-- ── restore_inventory (058) ──────────────────────────────────
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
  PERFORM assert_tenant_access(p_tenant_id);

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


-- ── process_backorder_release (054) ──────────────────────────
CREATE OR REPLACE FUNCTION process_backorder_release(
  p_tenant_id   UUID,
  p_order_id    UUID,
  p_customer_id UUID,
  p_amount      BIGINT,
  p_description TEXT DEFAULT NULL
) RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  PERFORM assert_tenant_access(p_tenant_id);

  INSERT INTO transactions (
    tenant_id, customer_id, order_id, source, type, amount, transaction_date, description
  ) VALUES (
    p_tenant_id, p_customer_id, p_order_id, 'cancel', 'receivable', p_amount, CURRENT_DATE, p_description
  );

  UPDATE orders
  SET outstanding_amount = GREATEST(0, outstanding_amount - p_amount)
  WHERE id = p_order_id;

  UPDATE customers
  SET outstanding_balance = outstanding_balance - p_amount
  WHERE id = p_customer_id AND tenant_id = p_tenant_id;
END;
$$;


-- ── process_return_item (056) ────────────────────────────────
CREATE OR REPLACE FUNCTION process_return_item(
  p_tenant_id   UUID,
  p_order_id    UUID,
  p_customer_id UUID,
  p_amount      BIGINT,
  p_description TEXT DEFAULT NULL
) RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_payment_status TEXT;
BEGIN
  PERFORM assert_tenant_access(p_tenant_id);

  SELECT payment_status INTO v_payment_status
  FROM orders WHERE id = p_order_id;

  INSERT INTO transactions (
    tenant_id, customer_id, order_id, source, type, amount, transaction_date, description
  ) VALUES (
    p_tenant_id, p_customer_id, p_order_id, 'return', 'receivable', p_amount, CURRENT_DATE, p_description
  );

  UPDATE orders
  SET outstanding_amount = GREATEST(0, outstanding_amount - p_amount)
  WHERE id = p_order_id;

  UPDATE customers
  SET outstanding_balance = CASE
    WHEN v_payment_status = 'paid'
    THEN outstanding_balance - p_amount
    ELSE GREATEST(0, outstanding_balance - p_amount)
  END
  WHERE id = p_customer_id AND tenant_id = p_tenant_id;
END;
$$;


-- ── process_undo_shipment (054) ──────────────────────────────
CREATE OR REPLACE FUNCTION process_undo_shipment(
  p_tenant_id   UUID,
  p_order_id    UUID,
  p_customer_id UUID
) RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_tx_id     UUID;
  v_tx_amount BIGINT;
BEGIN
  PERFORM assert_tenant_access(p_tenant_id);

  SELECT id, amount INTO v_tx_id, v_tx_amount
  FROM transactions
  WHERE tenant_id = p_tenant_id
    AND order_id  = p_order_id
    AND source    = 'shipment'
  ORDER BY created_at DESC
  LIMIT 1;

  IF v_tx_id IS NULL THEN RETURN; END IF;

  DELETE FROM transactions WHERE id = v_tx_id;

  UPDATE customers
  SET outstanding_balance = GREATEST(0, outstanding_balance - v_tx_amount)
  WHERE id = p_customer_id AND tenant_id = p_tenant_id;

  UPDATE orders
  SET outstanding_amount = 0
  WHERE id = p_order_id;
END;
$$;


-- ── process_sample_return (063) ──────────────────────────────
CREATE OR REPLACE FUNCTION process_sample_return(
  p_order_item_id UUID,
  p_tenant_id     UUID
) RETURNS JSON LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_item RECORD;
BEGIN
  PERFORM assert_tenant_access(p_tenant_id);

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


-- ── process_sample_convert (067) ─────────────────────────────
CREATE OR REPLACE FUNCTION process_sample_convert(
  p_order_item_id UUID,
  p_tenant_id     UUID
) RETURNS JSON LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_item             RECORD;
  v_amount           NUMERIC;
  v_new_order_id     UUID;
  v_new_order_number TEXT;
BEGIN
  PERFORM assert_tenant_access(p_tenant_id);

  SELECT
    oi.id, oi.order_id, oi.variant_id, oi.quantity, oi.unit_price,
    oi.is_sample, oi.sample_status,
    o.customer_id, o.customer_name, o.payment_method, o.order_number, o.order_type
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

  v_amount := v_item.quantity * v_item.unit_price;
  v_new_order_number := v_item.order_number || '-S'
                     || substr(replace(gen_random_uuid()::text, '-', ''), 1, 4);

  UPDATE order_items
  SET sample_status = 'converted',
      updated_at    = NOW()
  WHERE id = p_order_item_id;

  INSERT INTO orders (
    tenant_id, customer_id, customer_name, order_number, order_type,
    order_source, status, total_amount, vat_amount, paid_amount, outstanding_amount,
    payment_method, payment_status, memo
  ) VALUES (
    p_tenant_id, v_item.customer_id, v_item.customer_name, v_new_order_number,
    COALESCE(v_item.order_type, 'wholesale'),
    'sample_convert', 'shipped',
    v_amount, 0, 0, v_amount,
    v_item.payment_method, 'unpaid',
    '샘플 매입 전환 (원본: ' || v_item.order_number || ')'
  )
  RETURNING id INTO v_new_order_id;

  INSERT INTO order_items (
    order_id, variant_id, quantity, original_quantity, remaining_qty,
    unit_price, total_price, status, process_type,
    shipped_qty, shipped_at, is_sample, is_exchange,
    sample_status, sample_due_date
  ) VALUES (
    v_new_order_id, v_item.variant_id, v_item.quantity, v_item.quantity, 0,
    v_item.unit_price, v_amount, 'shipped', 'ordered',
    v_item.quantity, NOW(), FALSE, FALSE,
    NULL, NULL
  );

  PERFORM refresh_order_revenue(v_new_order_id);

  RETURN json_build_object(
    'success', true,
    'new_order_id', v_new_order_id,
    'new_order_number', v_new_order_number,
    'amount', v_amount
  );
END;
$$;


-- ── refresh_order_revenue (064) ──────────────────────────────
-- p_tenant_id 안 받음 → order_id 기반 가드 사용.
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
  PERFORM assert_order_tenant_access(p_order_id);

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


-- ── get_dashboard_kpi (012) ──────────────────────────────────
CREATE OR REPLACE FUNCTION get_dashboard_kpi(p_tenant_id UUID)
RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_today            DATE := CURRENT_DATE;
  v_today_count      INT;
  v_today_amount     BIGINT;
  v_today_received   BIGINT;
  v_total_outstanding BIGINT;
  v_pending_count    INT;
BEGIN
  PERFORM assert_tenant_access(p_tenant_id);

  SELECT COUNT(*), COALESCE(SUM(total_amount), 0)
  INTO v_today_count, v_today_amount
  FROM orders
  WHERE tenant_id  = p_tenant_id
    AND created_at::DATE = v_today;

  SELECT COALESCE(SUM(amount), 0)
  INTO v_today_received
  FROM transactions
  WHERE tenant_id       = p_tenant_id
    AND type            = 'income'
    AND transaction_date = v_today;

  SELECT COALESCE(SUM(outstanding_balance), 0)
  INTO v_total_outstanding
  FROM customers
  WHERE tenant_id          = p_tenant_id
    AND outstanding_balance > 0;

  SELECT COUNT(*)
  INTO v_pending_count
  FROM order_items oi
  JOIN orders o ON oi.order_id = o.id
  WHERE o.tenant_id   = p_tenant_id
    AND oi.item_type  IN ('backorder', 'order')
    AND oi.status NOT IN ('shipped', 'delivered', 'cancelled');

  RETURN json_build_object(
    'todayCount',       v_today_count,
    'todayAmount',      v_today_amount,
    'todayReceived',    v_today_received,
    'totalOutstanding', v_total_outstanding,
    'pendingCount',     v_pending_count
  );
END;
$$;


-- ── undo_day_payment (051) ───────────────────────────────────
CREATE OR REPLACE FUNCTION undo_day_payment(
  p_order_id  UUID,
  p_tenant_id UUID
) RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_tx RECORD;
BEGIN
  PERFORM assert_tenant_access(p_tenant_id);

  SELECT id, amount, customer_id INTO v_tx
  FROM transactions
  WHERE order_id  = p_order_id
    AND tenant_id = p_tenant_id
    AND type      = 'income'
  ORDER BY created_at DESC
  LIMIT 1;

  IF v_tx.id IS NULL THEN RETURN; END IF;

  DELETE FROM transactions WHERE id = v_tx.id;

  UPDATE orders
  SET outstanding_amount = revenue,
      payment_status     = 'unpaid'
  WHERE id = p_order_id AND tenant_id = p_tenant_id;

  UPDATE customers
  SET outstanding_balance = outstanding_balance + v_tx.amount
  WHERE id = v_tx.customer_id AND tenant_id = p_tenant_id;
END;
$$;


-- ── process_ship_item (015) — legacy, 코드 미사용 ────────────
CREATE OR REPLACE FUNCTION process_ship_item(
  p_order_item_id  UUID,
  p_qty            INT,
  p_tenant_id      UUID,
  p_keep_remainder BOOLEAN DEFAULT TRUE
)
RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_item              RECORD;
  v_new_shipped_qty   INT;
  v_original_qty      INT;
  v_is_complete       BOOLEAN;
  v_ship_amount       NUMERIC;
  v_pending_decrement NUMERIC;
  v_pending_tx        RECORD;
  v_tx_date           DATE := CURRENT_DATE;
  v_label             TEXT;
BEGIN
  PERFORM assert_tenant_access(p_tenant_id);

  SELECT
    oi.id, oi.quantity, oi.original_quantity, oi.shipped_qty,
    oi.unit_price, oi.item_type, oi.variant_id, oi.order_id, oi.status,
    o.customer_id, o.order_number, o.tenant_id
  INTO v_item
  FROM order_items oi
  JOIN orders o ON oi.order_id = o.id
  WHERE oi.id = p_order_item_id
    AND o.tenant_id = p_tenant_id;

  IF NOT FOUND THEN
    RETURN json_build_object('success', false, 'error', '항목을 찾을 수 없습니다.');
  END IF;

  IF v_item.status IN ('shipped', 'delivered') THEN
    RETURN json_build_object('success', false, 'error', '이미 처리된 항목입니다.');
  END IF;

  v_original_qty    := COALESCE(v_item.original_quantity, v_item.quantity);
  v_new_shipped_qty := COALESCE(v_item.shipped_qty, 0) + p_qty;
  v_is_complete     := v_new_shipped_qty >= v_original_qty;
  v_ship_amount     := p_qty * v_item.unit_price;
  v_pending_decrement := v_ship_amount;

  v_label := CASE v_item.item_type
    WHEN 'backorder' THEN '미송'
    WHEN 'order'     THEN '오더'
    WHEN 'sample'    THEN '샘플'
    ELSE '출고'
  END;

  UPDATE order_items
  SET shipped_qty = v_new_shipped_qty,
      status      = CASE WHEN v_is_complete THEN 'shipped' ELSE status END,
      shipped_at  = CASE WHEN v_is_complete THEN NOW() ELSE shipped_at END,
      updated_at  = NOW()
  WHERE id = p_order_item_id;

  UPDATE inventory
  SET quantity   = GREATEST(0, quantity - p_qty),
      updated_at = NOW()
  WHERE tenant_id  = p_tenant_id
    AND variant_id = v_item.variant_id;

  INSERT INTO transactions (
    tenant_id, customer_id, order_id, order_item_id,
    type, amount, method, description,
    transaction_date, source
  ) VALUES (
    p_tenant_id, v_item.customer_id, v_item.order_id, p_order_item_id,
    'receivable', v_ship_amount, NULL,
    v_item.order_number || ' 출고처리 (' || v_label || ')',
    v_tx_date, 'pos_sale'
  );

  SELECT id, amount INTO v_pending_tx
  FROM transactions
  WHERE order_id = v_item.order_id
    AND source   = 'pos_pending'
  LIMIT 1;

  IF FOUND THEN
    IF v_pending_tx.amount - v_pending_decrement <= 0 THEN
      DELETE FROM transactions WHERE id = v_pending_tx.id;
    ELSE
      UPDATE transactions
      SET amount = v_pending_tx.amount - v_pending_decrement
      WHERE id = v_pending_tx.id;
    END IF;
  END IF;

  RETURN json_build_object('success', true, 'ship_amount', v_ship_amount);
END;
$$;


-- ── reverse_ship_item (015) — legacy, 코드 미사용 ────────────
CREATE OR REPLACE FUNCTION reverse_ship_item(
  p_order_item_id UUID,
  p_tenant_id     UUID
)
RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_item        RECORD;
  v_pending_tx  RECORD;
  v_ship_amount NUMERIC;
  v_restore_qty INT;
BEGIN
  PERFORM assert_tenant_access(p_tenant_id);

  SELECT
    oi.id, oi.quantity, oi.original_quantity, oi.shipped_qty,
    oi.unit_price, oi.item_type, oi.variant_id, oi.order_id, oi.status,
    o.customer_id, o.order_number, o.tenant_id
  INTO v_item
  FROM order_items oi
  JOIN orders o ON oi.order_id = o.id
  WHERE oi.id = p_order_item_id
    AND o.tenant_id = p_tenant_id;

  IF NOT FOUND THEN
    RETURN json_build_object('success', false, 'error', '항목을 찾을 수 없습니다.');
  END IF;

  IF v_item.status != 'shipped' THEN
    RETURN json_build_object('success', false, 'error', '출고 상태가 아닙니다.');
  END IF;

  v_restore_qty := COALESCE(NULLIF(v_item.shipped_qty, 0), v_item.quantity);
  v_ship_amount := v_restore_qty * v_item.unit_price;

  UPDATE order_items
  SET shipped_qty = 0,
      status      = 'pending',
      shipped_at  = NULL,
      updated_at  = NOW()
  WHERE id = p_order_item_id;

  UPDATE inventory
  SET quantity   = quantity + v_restore_qty,
      updated_at = NOW()
  WHERE tenant_id  = p_tenant_id
    AND variant_id = v_item.variant_id;

  DELETE FROM transactions
  WHERE order_item_id = p_order_item_id
    AND source        = 'pos_sale';

  SELECT id, amount INTO v_pending_tx
  FROM transactions
  WHERE order_id = v_item.order_id
    AND source   = 'pos_pending'
  LIMIT 1;

  IF FOUND THEN
    UPDATE transactions
    SET amount = v_pending_tx.amount + v_ship_amount
    WHERE id = v_pending_tx.id;
  ELSE
    INSERT INTO transactions (
      tenant_id, customer_id, order_id,
      type, amount, method, description,
      transaction_date, source
    ) VALUES (
      p_tenant_id, v_item.customer_id, v_item.order_id,
      'receivable', v_ship_amount, NULL,
      v_item.order_number || ' 출고취소 복원',
      CURRENT_DATE, 'pos_pending'
    );
  END IF;

  RETURN json_build_object('success', true, 'reversed_amount', v_ship_amount);
END;
$$;


-- ── refresh_biz_session_stats (075) ──────────────────────────
-- biz_session_id 기반 가드 사용.
CREATE OR REPLACE FUNCTION refresh_biz_session_stats(p_biz_session_id UUID)
RETURNS biz_sessions
LANGUAGE plpgsql
AS $$
DECLARE
  v_tenant_id UUID;
  v_session   biz_sessions;
BEGIN
  PERFORM assert_biz_session_tenant_access(p_biz_session_id);

  SELECT tenant_id INTO v_tenant_id FROM biz_sessions WHERE id = p_biz_session_id;
  IF v_tenant_id IS NULL THEN
    RAISE EXCEPTION 'biz_session % not found', p_biz_session_id;
  END IF;

  DELETE FROM biz_session_customer_stats WHERE biz_session_id = p_biz_session_id;

  INSERT INTO biz_session_customer_stats
    (biz_session_id, tenant_id, customer_id, customer_name,
     sales_count, sales_amount, returns_count, returns_amount, purchase_count, purchase_amount)
  WITH agg AS (
    SELECT
      t.customer_id,
      MAX(c.company_name) AS company_name,
      COUNT(*) FILTER (WHERE t.source = 'shipment')::INT     AS sales_count,
      COALESCE(SUM(CASE WHEN t.source = 'shipment'     THEN t.amount ELSE 0 END), 0) AS sales_amount,
      COUNT(*) FILTER (WHERE t.source = 'return')::INT       AS returns_count,
      COALESCE(SUM(CASE WHEN t.source = 'return'       THEN t.amount ELSE 0 END), 0) AS returns_amount,
      COUNT(*) FILTER (WHERE t.source = 'credit_apply')::INT AS purchase_count,
      COALESCE(SUM(CASE WHEN t.source = 'credit_apply' THEN t.amount ELSE 0 END), 0) AS purchase_amount
    FROM transactions t
    LEFT JOIN customers c ON c.id = t.customer_id
    WHERE t.biz_session_id = p_biz_session_id
      AND t.customer_id IS NOT NULL
      AND t.source IN ('shipment', 'return', 'credit_apply')
    GROUP BY t.customer_id
  )
  SELECT
    p_biz_session_id, v_tenant_id, customer_id,
    COALESCE(company_name, '(미지정)') AS customer_name,
    sales_count, sales_amount, returns_count, returns_amount, purchase_count, purchase_amount
  FROM agg
  WHERE sales_count + returns_count + purchase_count > 0;

  DELETE FROM biz_session_product_stats WHERE biz_session_id = p_biz_session_id;

  INSERT INTO biz_session_product_stats
    (biz_session_id, tenant_id, variant_id, product_id, product_name, color, size, qty, amount)
  WITH eligible AS (
    SELECT
      oi.variant_id,
      pv.product_id,
      p.name AS product_name,
      pv.color,
      pv.size,
      CASE
        WHEN COALESCE(oi.is_sample, FALSE) OR COALESCE(oi.is_exchange, FALSE) THEN 0
        ELSE COALESCE(oi.shipped_qty, 0)
             + CASE WHEN oi.process_type = 'backorder' AND oi.status = 'unshipped'
                    THEN COALESCE(oi.remaining_qty, 0) ELSE 0 END
      END AS eligible_qty,
      oi.unit_price
    FROM orders o
    JOIN order_items     oi ON oi.order_id = o.id
    JOIN product_variants pv ON pv.id = oi.variant_id
    JOIN products         p  ON p.id  = pv.product_id
    WHERE o.biz_session_id = p_biz_session_id
      AND o.status <> 'cancelled'
  )
  SELECT
    p_biz_session_id, v_tenant_id, variant_id, product_id, product_name, color, size,
    SUM(eligible_qty)::INT,
    COALESCE(SUM(eligible_qty * unit_price), 0)
  FROM eligible
  WHERE eligible_qty > 0
  GROUP BY variant_id, product_id, product_name, color, size;

  WITH tx_cat AS (
    SELECT amount,
      CASE
        WHEN source = 'shipment'                                            THEN 'shipment'
        WHEN source = 'return'                                              THEN 'return'
        WHEN source = 'credit_apply'                                        THEN 'purchase'
        WHEN source = 'manual' AND customer_id IS NULL AND type = 'income'  THEN 'manual_in'
        WHEN source = 'manual' AND customer_id IS NULL AND type = 'expense' THEN 'manual_out'
        WHEN type = 'income' AND method = 'cash'                            THEN 'cash_in'
        WHEN type = 'income' AND method = 'transfer'                        THEN 'transfer_in'
        WHEN type = 'receivable'                                            THEN 'credit'
        ELSE 'other'
      END AS bucket
    FROM transactions
    WHERE biz_session_id = p_biz_session_id
  ),
  tx_stat AS (
    SELECT
      COUNT(*) FILTER (WHERE bucket = 'shipment')::INT       AS sales_count,
      COALESCE(SUM(amount) FILTER (WHERE bucket = 'shipment'),    0) AS sales_amount,
      COUNT(*) FILTER (WHERE bucket = 'return')::INT          AS returns_count,
      COALESCE(SUM(amount) FILTER (WHERE bucket = 'return'),      0) AS returns_amount,
      COUNT(*) FILTER (WHERE bucket = 'purchase')::INT        AS purchase_count,
      COALESCE(SUM(amount) FILTER (WHERE bucket = 'purchase'),    0) AS purchase_amount,
      COUNT(*) FILTER (WHERE bucket = 'cash_in')::INT         AS cash_in_count,
      COALESCE(SUM(amount) FILTER (WHERE bucket = 'cash_in'),     0) AS cash_in_amount,
      COUNT(*) FILTER (WHERE bucket = 'transfer_in')::INT     AS transfer_in_count,
      COALESCE(SUM(amount) FILTER (WHERE bucket = 'transfer_in'), 0) AS transfer_in_amount,
      COUNT(*) FILTER (WHERE bucket = 'credit')::INT          AS credit_count,
      COALESCE(SUM(amount) FILTER (WHERE bucket = 'credit'),      0) AS credit_amount,
      COUNT(*) FILTER (WHERE bucket = 'manual_in')::INT       AS manual_in_count,
      COALESCE(SUM(amount) FILTER (WHERE bucket = 'manual_in'),   0) AS manual_in_amount,
      COUNT(*) FILTER (WHERE bucket = 'manual_out')::INT      AS manual_out_count,
      COALESCE(SUM(amount) FILTER (WHERE bucket = 'manual_out'),  0) AS manual_out_amount
    FROM tx_cat
  ),
  vat_stat AS (
    SELECT
      COUNT(*) FILTER (WHERE o.vat_amount IS NOT NULL AND o.vat_amount <> 0)::INT AS vat_count,
      COALESCE(SUM(o.vat_amount), 0) AS vat_total
    FROM orders o
    WHERE o.biz_session_id = p_biz_session_id
      AND o.status <> 'cancelled'
      AND EXISTS (
        SELECT 1 FROM transactions t
        WHERE t.order_id = o.id
          AND t.source = 'shipment'
          AND t.biz_session_id = p_biz_session_id
      )
  ),
  inb_stat AS (
    SELECT
      COUNT(*)::INT                              AS inbound_count,
      COALESCE(SUM(COALESCE(total_amount, 0)),0) AS inbound_amount
    FROM inbound_orders WHERE biz_session_id = p_biz_session_id
  ),
  cust_count AS (
    SELECT COUNT(*)::INT AS n
    FROM biz_session_customer_stats
    WHERE biz_session_id = p_biz_session_id
  )
  UPDATE biz_sessions SET
    sales_count        = tx_stat.sales_count,
    sales_amount       = tx_stat.sales_amount,
    vat_count          = vat_stat.vat_count,
    vat_total          = vat_stat.vat_total,
    returns_count      = tx_stat.returns_count,
    returns_amount     = tx_stat.returns_amount,
    purchase_count     = tx_stat.purchase_count,
    purchase_amount    = tx_stat.purchase_amount,
    cash_in_count      = tx_stat.cash_in_count,
    cash_in_amount     = tx_stat.cash_in_amount,
    transfer_in_count  = tx_stat.transfer_in_count,
    transfer_in_amount = tx_stat.transfer_in_amount,
    credit_count       = tx_stat.credit_count,
    credit_amount      = tx_stat.credit_amount,
    manual_in_count    = tx_stat.manual_in_count,
    manual_in_amount   = tx_stat.manual_in_amount,
    manual_out_count   = tx_stat.manual_out_count,
    manual_out_amount  = tx_stat.manual_out_amount,
    inbound_count      = inb_stat.inbound_count,
    inbound_amount     = inb_stat.inbound_amount,
    customer_count     = cust_count.n,
    stats_finalized_at = now()
  FROM tx_stat, vat_stat, inb_stat, cust_count
  WHERE biz_sessions.id = p_biz_session_id
  RETURNING biz_sessions.* INTO v_session;

  RETURN v_session;
END;
$$;


-- ── settle_biz_session (075) ─────────────────────────────────
CREATE OR REPLACE FUNCTION settle_biz_session(
  p_biz_session_id UUID,
  p_closer_name    TEXT,
  p_closing_cash   NUMERIC
)
RETURNS biz_sessions
LANGUAGE plpgsql
AS $$
DECLARE
  v_session biz_sessions;
BEGIN
  PERFORM assert_biz_session_tenant_access(p_biz_session_id);

  SELECT * INTO v_session FROM biz_sessions
    WHERE id = p_biz_session_id FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'biz_session % not found', p_biz_session_id;
  END IF;
  IF v_session.status = 'closed' THEN
    RAISE EXCEPTION 'biz_session % is already closed', p_biz_session_id
      USING ERRCODE = 'P0002';
  END IF;
  IF p_closer_name IS NULL OR length(trim(p_closer_name)) = 0 THEN
    RAISE EXCEPTION 'closer_name is required';
  END IF;

  UPDATE biz_sessions SET
    status       = 'closed',
    closer_name  = trim(p_closer_name),
    closing_cash = COALESCE(p_closing_cash, 0),
    closed_at    = now()
  WHERE id = p_biz_session_id;

  RETURN refresh_biz_session_stats(p_biz_session_id);
END;
$$;
