-- ============================================================
-- 206: products.wholesale_price_current — 도매가 현재값 (원본 보존)
--
-- 작성: 2026-06-02
-- 배경: 샘플 시점 박제된 wholesale_price 는 원본(참고)으로 두고,
--   거래량 따라 도매가 인상/할인되면 "현재가"를 따로 편집 → 다음 전송부터 반영.
--   과거 노트 단가는 전송 시점 스냅샷이라 불변 (영수증 박제 원칙).
--   옵션 정공법(원본 안 해침)과 같은 결.
-- 전송 단가 우선순위: wholesale_price_current ?? wholesale_discount_price ?? wholesale_price
-- [[project_retail_slot_order_portal_v2]] [[feedback_receipt_snapshot_principle]]
-- ============================================================

BEGIN;

ALTER TABLE products ADD COLUMN IF NOT EXISTS wholesale_price_current NUMERIC;

COMMENT ON COLUMN products.wholesale_price_current IS
  '편집 가능한 현재 도매가. NULL=원본(wholesale_price) 사용. 전송 시 이 값이 노트에 스냅샷. 원본 wholesale_price 는 불변 참고.';

DO $$ BEGIN
  RAISE NOTICE '[206] products.wholesale_price_current 추가 (현재가 편집용, 원본 보존).';
END $$;

COMMIT;
