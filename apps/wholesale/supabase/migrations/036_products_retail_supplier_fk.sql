-- ============================================================
-- 036: products → retail_supplier_id (공급사 관계 태깅)
--
-- 작성: 2026-06-01
-- 배경: 샘플 등록 시 공급사(매장)를 slot 기반 거래처(retail_suppliers)로 태깅한다.
--   상품은 "자리(slot)"가 아니라 "사업자(관계 = retail_supplier)"를 따라가야 한다.
--   → 매장 이사/개명 시 retail_supplier 의 slot 포인터만 갱신하면, 상품은
--     retail_supplier_id(불변 id)에 묶여 있으므로 자동으로 따라간다.
--
--   [안건1] 샘플 공급사 picker → 이 컬럼 박제 (+ retail_suppliers 자동 생성)
--   [안건3] 외부주문포털 → 이 태깅을 거꾸로 읽어 "거래처별 내 상품" 발주
--
-- additive only. 기존 products.wholesale_supplier(TEXT, 마이그 182) 는
--   표시·fallback 으로 그대로 유지 (옛 텍스트 데이터 마이그 부담 0).
-- 신규 테이블 아님(ALTER) → RLS 자동활성 무관.
--
-- 관련: [[project_retail_slot_order_portal_v2]] [[project_retail_slot_register_ui]]
--       migrations/030_stores_schema.sql (slots/slot_stores/retail_suppliers 정의)
-- ============================================================

BEGIN;

-- ON DELETE SET NULL: 거래처가 삭제돼도 상품은 보존, 링크만 끊김.
-- (거래처는 폐업 시 hard-delete 대신 inactive 로 둘 예정 → 발동 거의 없음, 안전망)
ALTER TABLE products
  ADD COLUMN IF NOT EXISTS retail_supplier_id UUID
    REFERENCES retail_suppliers(id) ON DELETE SET NULL;

-- "내 상품 by 공급사" 조회용 부분 인덱스 (NULL 다수 → 가벼움)
CREATE INDEX IF NOT EXISTS idx_products_retail_supplier
  ON products(retail_supplier_id) WHERE retail_supplier_id IS NOT NULL;

DO $$
DECLARE
  v_total INT;
BEGIN
  SELECT COUNT(*) INTO v_total FROM products;
  RAISE NOTICE '[036] products.retail_supplier_id 추가 완료. 기존 % 행 전부 NULL (무영향).', v_total;
END $$;

COMMIT;
