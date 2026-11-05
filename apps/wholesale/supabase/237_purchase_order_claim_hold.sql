-- ============================================================
-- 237: 주문 시트 옵션별 반품·교환·수거완료·메모·보류 — purchase_order_items
--
-- 작성: 2026-11-05
-- 배경: 주문 줄(옵션)마다 반품/교환을 표시하고, 고객에게서 수거되면 수거완료 처리.
--   보류 건은 다음 날짜에도 계속 표시. 이 값들은 주문 이미지에 나가지 않음.
--   나중에 수거완료 시 재고 등록을 붙일 예정 — claim_quantity + claim_collected_at 이 기준.
-- ============================================================

BEGIN;

ALTER TABLE purchase_order_items
  ADD COLUMN IF NOT EXISTS claim_type         TEXT CHECK (claim_type IN ('return', 'exchange')),
  ADD COLUMN IF NOT EXISTS claim_quantity     INT,
  ADD COLUMN IF NOT EXISTS claim_collected_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS memo               TEXT,
  ADD COLUMN IF NOT EXISTS held_at            TIMESTAMPTZ;

COMMENT ON COLUMN purchase_order_items.claim_type IS '반품(return)/교환(exchange). NULL = 해당 없음';
COMMENT ON COLUMN purchase_order_items.claim_quantity IS '이 줄 수량 중 반품/교환 수량';
COMMENT ON COLUMN purchase_order_items.claim_collected_at IS '고객에게서 수거 완료한 시각. NULL = 수거 전';
COMMENT ON COLUMN purchase_order_items.memo IS '내부 메모 (주문 이미지에 안 나감)';
COMMENT ON COLUMN purchase_order_items.held_at IS '보류 시작 시각. NULL 이 아니면 이후 날짜에도 계속 표시';

COMMIT;
