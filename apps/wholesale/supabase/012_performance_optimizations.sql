-- ============================================================
-- 012_performance_optimizations.sql
-- Supabase SQL Editor에서 실행하세요
-- ============================================================

-- ─────────────────────────────────────────────
-- 1. pg_trgm 확장 (ilike 검색 인덱스용)
-- ─────────────────────────────────────────────
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- ─────────────────────────────────────────────
-- 2. 검색 성능 인덱스 (D: 전체텍스트 검색)
-- ─────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_customers_company_name_trgm
  ON customers USING gin (company_name gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_products_name_trgm
  ON products USING gin (name gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_orders_order_number_trgm
  ON orders USING gin (order_number gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_transactions_description_trgm
  ON transactions USING gin (description gin_trgm_ops);

-- ─────────────────────────────────────────────
-- 3. 공통 조회 인덱스
-- ─────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_orders_tenant_created
  ON orders (tenant_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_transactions_tenant_date
  ON transactions (tenant_id, transaction_date DESC);

CREATE INDEX IF NOT EXISTS idx_order_items_pending
  ON order_items (item_type, status)
  WHERE item_type IN ('backorder', 'order')
    AND status NOT IN ('shipped', 'delivered', 'cancelled');

CREATE INDEX IF NOT EXISTS idx_customers_outstanding
  ON customers (tenant_id, outstanding_balance)
  WHERE outstanding_balance > 0;

CREATE INDEX IF NOT EXISTS idx_inventory_tenant_variant
  ON inventory (tenant_id, variant_id);

-- inventory 유니크 제약 (없으면 추가, 있으면 무시)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'inventory_tenant_variant_unique'
  ) THEN
    ALTER TABLE inventory
      ADD CONSTRAINT inventory_tenant_variant_unique
      UNIQUE (tenant_id, variant_id);
  END IF;
END $$;

-- ─────────────────────────────────────────────
-- 4. 재고 차감 RPC (Fix 1, 4: N+1 → 1 쿼리)
-- ─────────────────────────────────────────────
CREATE OR REPLACE FUNCTION deduct_inventory(
  p_tenant_id  UUID,
  p_variant_id UUID,
  p_qty        INT
) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  UPDATE inventory
  SET quantity   = GREATEST(0, quantity - p_qty),
      updated_at = NOW()
  WHERE tenant_id  = p_tenant_id
    AND variant_id = p_variant_id;
END;
$$;

-- ─────────────────────────────────────────────
-- 5. 대시보드 KPI RPC (E: 4쿼리 → 1쿼리, tenant_id 격리 수정)
-- ─────────────────────────────────────────────
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
  -- 오늘 판매
  SELECT COUNT(*), COALESCE(SUM(total_amount), 0)
  INTO v_today_count, v_today_amount
  FROM orders
  WHERE tenant_id  = p_tenant_id
    AND created_at::DATE = v_today;

  -- 오늘 입금
  SELECT COALESCE(SUM(amount), 0)
  INTO v_today_received
  FROM transactions
  WHERE tenant_id       = p_tenant_id
    AND type            = 'income'
    AND transaction_date = v_today;

  -- 전체 미수금
  SELECT COALESCE(SUM(outstanding_balance), 0)
  INTO v_total_outstanding
  FROM customers
  WHERE tenant_id          = p_tenant_id
    AND outstanding_balance > 0;

  -- 미출고 대기 건수
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

-- ─────────────────────────────────────────────
-- 6. 주문 상태 자동 업데이트 트리거 (C: 출고처리 시 orders.status 자동화)
-- ─────────────────────────────────────────────
CREATE OR REPLACE FUNCTION fn_auto_update_order_status()
RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  -- order_item이 shipped로 변경될 때만 처리
  IF NEW.status = 'shipped' AND (OLD.status IS NULL OR OLD.status != 'shipped') THEN
    -- 해당 주문의 미출고 아이템이 더 없으면 orders.status = 'shipped'
    IF NOT EXISTS (
      SELECT 1
      FROM order_items
      WHERE order_id = NEW.order_id
        AND id       != NEW.id
        AND status NOT IN ('shipped', 'delivered', 'cancelled')
    ) THEN
      UPDATE orders
      SET status = 'shipped'
      WHERE id = NEW.order_id
        AND status NOT IN ('shipped', 'delivered', 'cancelled');
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_auto_update_order_status ON order_items;
CREATE TRIGGER trg_auto_update_order_status
  AFTER UPDATE OF status ON order_items
  FOR EACH ROW
  EXECUTE FUNCTION fn_auto_update_order_status();
