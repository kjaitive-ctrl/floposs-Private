-- ============================================================
-- 016_source_order.sql
-- orders 테이블에 source_order_id 컬럼 추가
-- 미송/오더 출고 시 생성되는 SAL 주문이 원본 주문을 참조
-- ============================================================

ALTER TABLE orders ADD COLUMN IF NOT EXISTS source_order_id UUID REFERENCES orders(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_orders_source_order ON orders(source_order_id);
