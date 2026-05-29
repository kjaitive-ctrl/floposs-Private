-- ============================================================
-- 201: products.sold_out — 상품 전체 품절 토글
--
-- 작성: 2026-05-29
-- 사장 결정:
--   - variant 단위 sold_out (마이그 188) 와 별개로 product 단위 전체품절 토글 신설
--   - retail /products 상품명 우측 작은 버튼으로 토글
--   - 의미: 일시적 상품 전체 품절 (입고 대기, 공급사 이슈 등)
--   - variant.sold_out 와 OR 관계: 둘 중 하나라도 true 면 주문 불가
--
-- 본 마이그
--   ALTER TABLE products ADD COLUMN sold_out BOOLEAN DEFAULT false
--
-- 영향 매트릭스
--   - 기본값 false → 기존 row 영향 0
--   - retail /products: 토글 버튼 (별 작업)
--   - 주문 시 가드: variant.sold_out OR product.sold_out (별 작업 — 주문 path 검토 시)
--
-- 멱등
-- ============================================================

BEGIN;

ALTER TABLE products
  ADD COLUMN IF NOT EXISTS sold_out BOOLEAN DEFAULT false;

COMMENT ON COLUMN products.sold_out IS 'retail: 상품 전체 품절 토글. variant.sold_out 와 OR 관계 — 둘 중 하나라도 true 면 주문 불가.';

COMMIT;
