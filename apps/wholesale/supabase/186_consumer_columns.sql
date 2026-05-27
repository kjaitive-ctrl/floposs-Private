-- ============================================================
-- 186: retail Phase I — 소비자(consumer) 박제 컬럼 4개
--
-- 작성: 2026-05-25
-- 사장 결정 (2026-05-25 회의):
--   /products 페이지 = retail 소비자 판매용 표기 박제.
--   /samples (공급 박제, wholesale_*) 와 별개 set 으로 유지.
--   소비자 옵션은 공급 옵션(product_variants) 과 의도적으로 분리:
--     공급 "딥블루" → 소비자 "네이비" 같은 가공/재명명 가능하게.
--   매칭(v3 product_mappings) 도구는 미래 시점 검토.
--
-- 본 마이그
--   products ALTER 4 컬럼 — 전부 NULL default, 기존 row 영향 0
--     consumer_name      — 소비자 상품명 (products.name 과 별도 박제)
--     consumer_option1   — 소비자 옵션1 (텍스트, 콤마 분리 가능)
--     consumer_option2   — 소비자 옵션2
--     consumer_option3   — 소비자 옵션3
--
-- 영향 매트릭스
--   - 기존 row (wholesale/retail 둘 다): 신규 컬럼 NULL → SELECT 영향 0
--   - wholesale UI 코드: 신규 컬럼 안 가져옴 → 영향 0
--   - retail /products 페이지: 사장이 셀 입력 → UPDATE consumer_*
--   - product_variants: 손대지 않음 (공급 옵션 set 그대로)
--
-- 관련 마이그
--   - 182 (retail Phase I 기본 컬럼) — wholesale_* + consumer_price/regular_sale_price + status
--   - 183 (3축 옵션) — product_variants.option3 + products.option{1,2,3}_label
--
-- 멱등 + BEGIN/COMMIT
-- ============================================================

BEGIN;

ALTER TABLE products
  ADD COLUMN IF NOT EXISTS consumer_name    TEXT,
  ADD COLUMN IF NOT EXISTS consumer_option1 TEXT,
  ADD COLUMN IF NOT EXISTS consumer_option2 TEXT,
  ADD COLUMN IF NOT EXISTS consumer_option3 TEXT;

COMMENT ON COLUMN products.consumer_name    IS 'retail 박제: 소비자에게 표기되는 상품명. 공급 wholesale_name 과 별개 박제 (재명명/가공 가능). products.name 은 기존 호환용으로 유지.';
COMMENT ON COLUMN products.consumer_option1 IS 'retail 박제: 소비자 옵션1 텍스트. 공급 product_variants 와 무관한 별도 표기.';
COMMENT ON COLUMN products.consumer_option2 IS 'retail 박제: 소비자 옵션2 텍스트.';
COMMENT ON COLUMN products.consumer_option3 IS 'retail 박제: 소비자 옵션3 텍스트.';

DO $$
DECLARE
  v_total INT;
BEGIN
  SELECT COUNT(*) INTO v_total FROM products;
  RAISE NOTICE '[186] retail consumer 컬럼 4개 박힘. products 전체 % rows.', v_total;
END $$;

COMMIT;
