-- ============================================================
-- 182: retail products Phase I — retail-only 필드 9개 박기
--
-- 작성: 2026-05-20
-- 사장 결정 (2026-05-20 회의):
--   1. retail vertical 자체 운영 시작 (Phase I). wholesale 연동은 v3+ 보류.
--   2. C-1 단일 모델 — retail tenant 도 products 테이블 재사용 (tenant_id 격리).
--   3. wholesale 박제값 + retail 자체 가격 두 종류 모두 박을 수 있어야 함.
--   4. 샘플 워크플로우 — status 기반 페이지 필터 (옛 feedback_retail_product_workflow 원칙 유지).
--
-- 본 마이그
--   products ALTER 9 컬럼 — 전부 NULL default, wholesale 기존 row 영향 0
--     ① wholesale 박제 (retail 사장이 텍스트 입력) 4개:
--        wholesale_name, wholesale_supplier, wholesale_price, wholesale_discount_price
--     ② retail 자체 가격 2개:
--        consumer_price, regular_sale_price
--     ③ 샘플 워크플로우 3개:
--        status (CHECK), return_deadline, return_shipped_date
--
-- 영향 매트릭스
--   - wholesale 기존 row: 신규 컬럼 전부 NULL → SELECT 영향 0
--   - wholesale UI 코드: 신규 컬럼 안 가져옴 → 영향 0
--   - retail 신규 row: 신규 컬럼 사장 입력으로 박제 (/samples 페이지)
--   - 기존 컬럼 재사용: name, product_code, category, description, material_composition,
--                       country_of_origin, launch_date, sale_price
--
-- 관련 마이그
--   - 175 (retail v1 인프라) — tenants 보강 + 옛 retail_* 테이블 폐기
--   - 183 (옵션 시스템) — option3 + option1/2/3_label
--   - 184 (사이즈표 템플릿) — measurement_templates
--
-- 멱등 + BEGIN/COMMIT
-- ============================================================

BEGIN;


-- ─────────────────────────────────────────────────────────
-- ① wholesale 박제 (retail 사장이 도매 거래에서 받은 정보 텍스트 박제)
-- ─────────────────────────────────────────────────────────
-- 매칭 (v3 product_mappings) 시점까지는 retail 측 자체 박제.
-- 매칭 후엔 product_mappings 통해 wholesale products 실시간 JOIN 조회 가능.
-- 박제값은 시점 박제로 유지 (회계 정합 — feedback_accounting_integrity).
ALTER TABLE products
  ADD COLUMN IF NOT EXISTS wholesale_name           TEXT,
  ADD COLUMN IF NOT EXISTS wholesale_supplier       TEXT,
  ADD COLUMN IF NOT EXISTS wholesale_price          NUMERIC(12,2),
  ADD COLUMN IF NOT EXISTS wholesale_discount_price NUMERIC(12,2);

COMMENT ON COLUMN products.wholesale_name           IS 'retail 박제: 공급사(도매)가 부르는 상품명. v3 매칭 후 wholesale products.name JOIN 가능.';
COMMENT ON COLUMN products.wholesale_supplier       IS 'retail 박제: 공급사명(도매업체). v3 매칭 후 wholesale tenants.company_name JOIN 가능.';
COMMENT ON COLUMN products.wholesale_price          IS 'retail 박제: 도매 공급가(사입가). v3 매칭 후 wholesale products.sale_price JOIN 가능.';
COMMENT ON COLUMN products.wholesale_discount_price IS 'retail 박제: 도매 특별할인가.';


-- ─────────────────────────────────────────────────────────
-- ② retail 자체 가격 (소비자 판매)
-- ─────────────────────────────────────────────────────────
-- 기존 sale_price 컬럼은 retail 판매가(=실제 판매가)로 재사용.
-- 추가 2개:
--   consumer_price        — 소비자가 (정가). 표시용.
--   regular_sale_price    — 상시할인가.
ALTER TABLE products
  ADD COLUMN IF NOT EXISTS consumer_price     NUMERIC(12,2),
  ADD COLUMN IF NOT EXISTS regular_sale_price NUMERIC(12,2);

COMMENT ON COLUMN products.consumer_price     IS 'retail 가격: 소비자가(정가). 소비자 표시용. retail-only.';
COMMENT ON COLUMN products.regular_sale_price IS 'retail 가격: 상시할인가. retail-only.';


-- ─────────────────────────────────────────────────────────
-- ③ 샘플 워크플로우 — status + 반납 정보
-- ─────────────────────────────────────────────────────────
-- status 값/페이지 매핑 (옛 feedback_retail_product_workflow):
--   샘플 페이지(/samples):  sample_received, shooting_done, returned
--   판매상품 페이지:        registered, inactive
-- 자동 전환 X — 사장이 수동 변경.
ALTER TABLE products
  ADD COLUMN IF NOT EXISTS status              TEXT,
  ADD COLUMN IF NOT EXISTS return_deadline     DATE,
  ADD COLUMN IF NOT EXISTS return_shipped_date DATE;

-- status CHECK — NULL 허용 (wholesale row 영향 0)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'products_status_check'
  ) THEN
    ALTER TABLE products
      ADD CONSTRAINT products_status_check
      CHECK (status IS NULL
          OR status IN ('sample_received','shooting_done','registered','returned','inactive'));
  END IF;
END $$;

COMMENT ON COLUMN products.status              IS 'retail 샘플 워크플로우: sample_received/shooting_done/registered/returned/inactive. NULL=wholesale row 또는 미설정.';
COMMENT ON COLUMN products.return_deadline     IS 'retail 샘플 반납기한. v3 매칭 후 wholesale tenants.sample_period_days 로 자동 계산 가능.';
COMMENT ON COLUMN products.return_shipped_date IS 'retail 샘플 반납 출고일. 반납 처리 시 박제.';


-- ─────────────────────────────────────────────────────────
-- 인덱스 (retail /samples 페이지 status 필터 성능)
-- ─────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_products_tenant_status
  ON products(tenant_id, status)
  WHERE status IS NOT NULL;


-- ─────────────────────────────────────────────────────────
-- 완료 메시지
-- ─────────────────────────────────────────────────────────
DO $$
DECLARE
  v_total      INT;
  v_with_status INT;
BEGIN
  SELECT COUNT(*) INTO v_total       FROM products;
  SELECT COUNT(*) INTO v_with_status FROM products WHERE status IS NOT NULL;
  RAISE NOTICE '[182] retail products Phase I 컬럼 9개 박힘. products 전체 % rows (status 채워진 row: %).',
    v_total, v_with_status;
END $$;

COMMIT;
