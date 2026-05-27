-- order_items에 item_type 추가 (ship=출고, backorder=미송, order=오더)
ALTER TABLE order_items
  ADD COLUMN IF NOT EXISTS item_type TEXT DEFAULT 'ship'
  CHECK (item_type IN ('ship', 'backorder', 'order'));

-- 기존 is_backorder 데이터 마이그레이션
UPDATE order_items SET item_type = 'backorder' WHERE is_backorder = true AND item_type = 'ship';
