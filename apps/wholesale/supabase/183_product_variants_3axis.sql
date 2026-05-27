-- ============================================================
-- 183: product_variants 3축 옵션 인프라 — 옵션 라벨 + option3 + partial unique index
--
-- 작성: 2026-05-20
-- 사장 결정 (2026-05-20 회의):
--   1. retail 은 소비자 마케팅 단위로 3축 옵션 (예: 색상/사이즈/패턴) 자유.
--   2. wholesale 은 기존 2축 (색상/사이즈) UI 그대로 유지. DB만 3축 가능하게 박음.
--   3. 매칭(v3 product_mappings) 은 PK 단위 N:M — 축 수 불일치 자유 허용.
--   4. 옵션 라벨은 products 행 단위 박제. NULL fallback 으로 wholesale UI 영향 0.
--
-- 본 마이그
--   ① products 에 옵션 라벨 3개 컬럼 추가 (NULL default)
--      option1_label, option2_label, option3_label
--      → wholesale: NULL fallback "색상"/"사이즈"
--      → retail: 명시 박제 "색상"/"사이즈"/"패턴" 등
--   ② product_variants 에 option3 컬럼 추가 (NULL default)
--   ③ UNIQUE 제약 재구성 (NULL 함정 회피 — partial unique index 2개)
--      옛: UNIQUE(product_id, color, size)
--      새: partial index — option3 NULL ↔ NOT NULL 분리
--
-- 영향 매트릭스
--   - wholesale 기존 row: option3 = NULL → 2축 partial index 적용 → UNIQUE 보장 동일
--   - wholesale UI: option*_label 안 가져옴, "색상"/"사이즈" 하드코딩 유지 → 영향 0
--   - wholesale INSERT (ProductModal.tsx:148 color/size 만): option3 자동 NULL → 정합
--   - retail 신규 row: option3 + label 박제 → 3축 partial index 적용
--   - JOIN 키는 variant_id PK — 옵션 축 수 무관, 회귀 0
--
-- 함정 회피 (PostgreSQL NULL UNIQUE)
--   PostgreSQL UNIQUE 비교에서 NULL 은 항상 distinct.
--   단순 UNIQUE(product_id, color, size, option3) 로 변경하면
--   (P1, BLACK, M, NULL) 두 row 가 허용됨 → 2축 UNIQUE 깨짐.
--   해결: partial unique index 2개로 NULL ↔ NOT NULL 분리.
--
-- 멱등 + BEGIN/COMMIT
-- ============================================================

BEGIN;


-- ─────────────────────────────────────────────────────────
-- ① products 옵션 라벨 컬럼 3개
-- ─────────────────────────────────────────────────────────
ALTER TABLE products
  ADD COLUMN IF NOT EXISTS option1_label TEXT,
  ADD COLUMN IF NOT EXISTS option2_label TEXT,
  ADD COLUMN IF NOT EXISTS option3_label TEXT;

COMMENT ON COLUMN products.option1_label IS '옵션1 라벨 (예: "색상"). NULL=옛 wholesale row, UI는 "색상" fallback.';
COMMENT ON COLUMN products.option2_label IS '옵션2 라벨 (예: "사이즈"). NULL=옛 wholesale row, UI는 "사이즈" fallback.';
COMMENT ON COLUMN products.option3_label IS '옵션3 라벨 (예: "패턴", "원단"). NULL=2축 상품, UI에서 third 컬럼 자체 안 보임.';


-- ─────────────────────────────────────────────────────────
-- ② product_variants.option3 컬럼
-- ─────────────────────────────────────────────────────────
ALTER TABLE product_variants
  ADD COLUMN IF NOT EXISTS option3 TEXT;

COMMENT ON COLUMN product_variants.option3 IS '옵션3 값 (예: "스트라이프"). NULL=2축 variant (옛 wholesale 호환). 라벨은 products.option3_label.';


-- ─────────────────────────────────────────────────────────
-- ③ UNIQUE 제약 재구성 — partial unique index 2개
-- ─────────────────────────────────────────────────────────
-- 옛 UNIQUE 제약 DROP (멱등)
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'product_variants_product_id_color_size_key'
  ) THEN
    ALTER TABLE product_variants
      DROP CONSTRAINT product_variants_product_id_color_size_key;
    RAISE NOTICE '[183] 옛 UNIQUE(product_id, color, size) DROP 완료';
  END IF;
END $$;

-- 2축 partial index — option3 NULL 일 때 (product_id, color, size) UNIQUE
CREATE UNIQUE INDEX IF NOT EXISTS uniq_product_variants_2axis
  ON product_variants (product_id, color, size)
  WHERE option3 IS NULL;

-- 3축 partial index — option3 채워진 경우 (product_id, color, size, option3) UNIQUE
CREATE UNIQUE INDEX IF NOT EXISTS uniq_product_variants_3axis
  ON product_variants (product_id, color, size, option3)
  WHERE option3 IS NOT NULL;


-- ─────────────────────────────────────────────────────────
-- 완료 메시지 + 검증
-- ─────────────────────────────────────────────────────────
DO $$
DECLARE
  v_variants_total INT;
  v_variants_3axis INT;
  v_dup_check      INT;
BEGIN
  SELECT COUNT(*) INTO v_variants_total FROM product_variants;
  SELECT COUNT(*) INTO v_variants_3axis FROM product_variants WHERE option3 IS NOT NULL;

  -- 2축 UNIQUE 회귀 검증 — 같은 (product_id, color, size, option3=NULL) 중복 없어야 함
  SELECT COUNT(*) INTO v_dup_check FROM (
    SELECT product_id, color, size, COUNT(*) c
    FROM product_variants
    WHERE option3 IS NULL
    GROUP BY product_id, color, size
    HAVING COUNT(*) > 1
  ) sub;

  IF v_dup_check > 0 THEN
    RAISE EXCEPTION '[183 회귀 감지] 2축 (product_id, color, size) 중복 row % 건. partial index 적용 전 데이터 정리 필요.', v_dup_check;
  END IF;

  RAISE NOTICE '[183] 3축 옵션 인프라 박힘. product_variants 전체 % rows (3축: %). 2축 UNIQUE 정합 검증 통과.',
    v_variants_total, v_variants_3axis;
END $$;

COMMIT;
