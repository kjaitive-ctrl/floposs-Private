-- ============================================================
-- 239: 주문 시트 출고수량 — purchase_order_items (보유재고)
--
-- 작성: 2026-11-09
-- 배경: 줄마다 보유 = 입고수량 + 반품·교환 수거완료 수량 − 출고수량.
--   보유가 남은 줄은 주문 화면 [보유재고] 목록에 뜨고, 장수를 적어 부분 출고 가능.
--   출고는 누적 수량만 기록 (언제 몇 장 나갔는지 이력은 아직 없음).
-- ============================================================

BEGIN;

ALTER TABLE purchase_order_items
  ADD COLUMN IF NOT EXISTS shipped_quantity INT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS shipped_at       TIMESTAMPTZ;

COMMENT ON COLUMN purchase_order_items.shipped_quantity IS '보유분 중 출고한 누적 수량';
COMMENT ON COLUMN purchase_order_items.shipped_at IS '마지막 출고 시각';

COMMIT;
