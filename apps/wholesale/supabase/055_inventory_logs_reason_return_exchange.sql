-- ============================================================
-- 055: inventory_logs reason_check에 'return', 'exchange' 추가
--
-- 기존: ('shipment', 'receipt', 'adjustment', 'undo')
-- 변경: + 'return' (반품), 'exchange' (교환)
-- ============================================================

ALTER TABLE inventory_logs
  DROP CONSTRAINT IF EXISTS inventory_logs_reason_check;

ALTER TABLE inventory_logs
  ADD CONSTRAINT inventory_logs_reason_check
  CHECK (reason IN ('shipment', 'receipt', 'adjustment', 'undo', 'return', 'exchange'));
