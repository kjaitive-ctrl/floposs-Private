-- ============================================================
-- 246: 지그재그 주문 엑셀 → 주문 탭(사입 주문서) 가져오기
--
-- 작성: 2026-11-23
-- 지그재그 "배송준비중" 주문 엑셀을 주문 탭에 올리면 상품을 찾아 주문서 줄을 만듦.
--   같은 상품·같은 옵션은 한 줄로 합침(수량 합).
--   이미 올린 상품주문번호는 건너뜀 → purchase_order_items.zigzag_order_nos.
--   한 번 연결된 상품에는 지그재그 상품번호를 저장 → 다음부터 그 번호로 바로 찾음.
--   원본(지그재그 상품명·옵션·수량·가격·코드)은 zigzag_source 에 그대로. 구매자 개인정보는 저장 안 함.
-- 칼럼 추가만이라 RLS 함정 없음.
-- ============================================================

BEGIN;

ALTER TABLE purchase_order_items
  ADD COLUMN IF NOT EXISTS zigzag_order_nos  TEXT[],  -- 이 줄에 합쳐진 지그재그 상품주문번호들
  ADD COLUMN IF NOT EXISTS zigzag_product_no TEXT,    -- 지그재그 상품번호 (미분류 줄을 고칠 때 상품에 저장할 값)
  ADD COLUMN IF NOT EXISTS zigzag_source     JSONB;   -- 원본 줄들 [{order_no, name, option, qty, price, code, own_code}]

COMMENT ON COLUMN purchase_order_items.zigzag_order_nos  IS '지그재그 엑셀에서 온 줄 — 합쳐진 상품주문번호 (중복 업로드 방지)';
COMMENT ON COLUMN purchase_order_items.zigzag_product_no IS '지그재그 상품번호';
COMMENT ON COLUMN purchase_order_items.zigzag_source     IS '지그재그 원본 줄 (상품명·옵션·수량·가격·코드, 개인정보 제외)';

CREATE INDEX IF NOT EXISTS idx_poi_zigzag_order_nos
  ON purchase_order_items USING GIN (zigzag_order_nos);

ALTER TABLE products
  ADD COLUMN IF NOT EXISTS zigzag_product_no TEXT;
COMMENT ON COLUMN products.zigzag_product_no IS '지그재그 상품번호 — 주문 엑셀 가져오기에서 한 번 연결되면 저장';

-- 매장 안에서 한 지그재그 상품번호 = 한 상품
CREATE UNIQUE INDEX IF NOT EXISTS uq_products_tenant_zigzag_no
  ON products (tenant_id, zigzag_product_no) WHERE zigzag_product_no IS NOT NULL;

COMMIT;

-- 확인
SELECT table_name, column_name FROM information_schema.columns
 WHERE (table_name = 'purchase_order_items' AND column_name LIKE 'zigzag_%')
    OR (table_name = 'products' AND column_name = 'zigzag_product_no')
 ORDER BY table_name, column_name;
