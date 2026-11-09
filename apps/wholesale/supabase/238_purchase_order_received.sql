-- ============================================================
-- 238: 주문 시트 입고수량 + 미입고 — purchase_order_items
--
-- 작성: 2026-11-09
-- 배경: 주문한 줄이 실제로 몇 개 들어왔는지(입고수량) 적고, 안 들어온 줄은 [미입고]로
--   표시해 다음 날짜부터 보류처럼 맨 위에 계속 보이게 함. 다 들어오면 자동으로 풀림.
--   미입고는 held_at(237) 을 같이 쓰고 held_reason 으로 보류와 구분.
-- ============================================================

BEGIN;

ALTER TABLE purchase_order_items
  ADD COLUMN IF NOT EXISTS received_quantity INT,
  ADD COLUMN IF NOT EXISTS held_reason       TEXT CHECK (held_reason IN ('not_received'));

COMMENT ON COLUMN purchase_order_items.received_quantity IS '입고된 수량. NULL = 아직 확인 안 함';
COMMENT ON COLUMN purchase_order_items.held_reason IS 'held_at 의 이유. NULL = 보류, not_received = 미입고';

COMMIT;
