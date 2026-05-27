-- ============================================================
-- 188: retail Phase I — variant 단위 정공법 박제
--
-- 작성: 2026-05-25
-- 사장 결정 (2026-05-25 회의):
--   1. [진행] = variants 확정. variant 단위 상품코드 박제 (R-001-01)
--   2. 공급 ↔ 판매 매칭 = 한 테이블 + is_for_sale 토글 (부분집합)
--   3. /products = chip 인터페이스. 통째 텍스트 수정 차단. + 추가 시만 콤마 허용
--   4. consumer_option1/2/3 (마이그 186) 폐기 방향 — variant 단위 박제로 이전
--
-- 본 마이그
--   product_variants ALTER 6 컬럼 (전부 NULL/default 허용)
--     is_for_sale            BOOLEAN DEFAULT true   — 판매 토글. [진행] 시 자동 true
--     sold_out               BOOLEAN DEFAULT false  — 일시 품절
--     consumer_label_color   TEXT                   — 소비자 표기 라벨 (공급 color 와 별도)
--     consumer_label_size    TEXT
--     consumer_label_option3 TEXT
--     variant_code           TEXT                   — 사람 읽기 코드 (R-001-01)
--   기존 variants backfill — variant_code 박제 + consumer_label_* = color/size/option3 fallback
--   trigger fill_variant_code            — INSERT 시 NULL 이면 자동 박제
--   trigger fill_variant_consumer_labels — INSERT 시 NULL 이면 color/size/option3 fallback
--   unique 인덱스 — variant_code 글로벌
--
-- 영향 매트릭스
--   - 기존 row: default 박힘 (is_for_sale=true, sold_out=false). label/code 자동 박제
--   - wholesale UI: 신규 컬럼 안 가져옴 → 영향 0
--   - retail /samples: variant INSERT 시 트리거 자동 박제. fetchItems SELECT 확장 필요 (별 작업)
--   - retail /products: chip 인터페이스 신설 (별 작업)
--   - consumer_option1/2/3 (마이그 186): DROP X. 폐기 방향만. 코드에서 안 쓰면 됨.
--
-- 관련 마이그
--   - 183 (3축 옵션)
--   - 186 (consumer_option*) — 폐기 방향
--   - 187 (progress_memo)
--
-- 멱등 + BEGIN/COMMIT
-- ============================================================

BEGIN;

-- ─────────────────────────────────────────────────────────
-- ① 컬럼 6개 ALTER
-- ─────────────────────────────────────────────────────────
ALTER TABLE product_variants
  ADD COLUMN IF NOT EXISTS is_for_sale            BOOLEAN DEFAULT true,
  ADD COLUMN IF NOT EXISTS sold_out               BOOLEAN DEFAULT false,
  ADD COLUMN IF NOT EXISTS consumer_label_color   TEXT,
  ADD COLUMN IF NOT EXISTS consumer_label_size    TEXT,
  ADD COLUMN IF NOT EXISTS consumer_label_option3 TEXT,
  ADD COLUMN IF NOT EXISTS variant_code           TEXT;

COMMENT ON COLUMN product_variants.is_for_sale            IS 'retail: 판매 토글. 공급 박제와 부분집합 매칭. default true. [진행] 시 모두 true 자동.';
COMMENT ON COLUMN product_variants.sold_out               IS 'retail: 일시 품절 토글. is_for_sale=true 라도 sold_out=true 면 주문 불가.';
COMMENT ON COLUMN product_variants.consumer_label_color   IS 'retail: 소비자 표기 라벨 (color). 공급 color 와 별개. INSERT 시 NULL 이면 color 와 동일 박제.';
COMMENT ON COLUMN product_variants.consumer_label_size    IS 'retail: 소비자 표기 라벨 (size).';
COMMENT ON COLUMN product_variants.consumer_label_option3 IS 'retail: 소비자 표기 라벨 (option3).';
COMMENT ON COLUMN product_variants.variant_code           IS 'retail: variant 단위 사람 읽기 상품코드 (R-001-01). INSERT 트리거 자동 박제. 글로벌 unique.';


-- ─────────────────────────────────────────────────────────
-- ② variant_code 자동 발급 trigger
-- ─────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION fill_variant_code()
RETURNS TRIGGER AS $$
DECLARE
  v_product_code TEXT;
  v_next_num     INT;
BEGIN
  IF NEW.variant_code IS NOT NULL THEN
    RETURN NEW;
  END IF;
  SELECT product_code INTO v_product_code FROM products WHERE id = NEW.product_id;
  IF v_product_code IS NULL THEN
    RETURN NEW; -- product_code 없으면 박제 skip (런타임에 박제됨)
  END IF;
  -- 같은 product 의 기존 variant 들 중 가장 큰 suffix 번호 + 1
  -- (soft delete 된 variant 도 counted — variant_code 재발급 방지)
  SELECT COALESCE(MAX((regexp_match(variant_code, '-([0-9]+)$'))[1]::INT), 0) + 1
    INTO v_next_num
    FROM product_variants
    WHERE product_id = NEW.product_id
      AND variant_code LIKE v_product_code || '-%';
  NEW.variant_code := v_product_code || '-' || LPAD(v_next_num::TEXT, 2, '0');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_fill_variant_code ON product_variants;
CREATE TRIGGER trg_fill_variant_code
  BEFORE INSERT ON product_variants
  FOR EACH ROW
  EXECUTE FUNCTION fill_variant_code();


-- ─────────────────────────────────────────────────────────
-- ③ consumer_label_* 자동 fallback trigger
-- ─────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION fill_variant_consumer_labels()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.consumer_label_color   IS NULL THEN NEW.consumer_label_color   := NEW.color;   END IF;
  IF NEW.consumer_label_size    IS NULL THEN NEW.consumer_label_size    := NEW.size;    END IF;
  IF NEW.consumer_label_option3 IS NULL THEN NEW.consumer_label_option3 := NEW.option3; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_fill_variant_consumer_labels ON product_variants;
CREATE TRIGGER trg_fill_variant_consumer_labels
  BEFORE INSERT ON product_variants
  FOR EACH ROW
  EXECUTE FUNCTION fill_variant_consumer_labels();


-- ─────────────────────────────────────────────────────────
-- ④ 기존 variants backfill
-- ─────────────────────────────────────────────────────────
-- variant_code — product_code 있는 row 만, created_at 순서로 01부터
DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT v.id,
           p.product_code || '-' || LPAD(
             ROW_NUMBER() OVER (PARTITION BY v.product_id ORDER BY v.created_at, v.id)::TEXT, 2, '0'
           ) AS new_code
    FROM product_variants v
    JOIN products p ON v.product_id = p.id
    WHERE v.variant_code IS NULL
      AND p.product_code IS NOT NULL
  LOOP
    UPDATE product_variants SET variant_code = r.new_code WHERE id = r.id;
  END LOOP;
END $$;

-- consumer_label_* — NULL 인 row 는 color/size/option3 와 동일 박제
UPDATE product_variants
   SET consumer_label_color   = COALESCE(consumer_label_color,   color),
       consumer_label_size    = COALESCE(consumer_label_size,    size),
       consumer_label_option3 = COALESCE(consumer_label_option3, option3)
 WHERE consumer_label_color   IS NULL
    OR consumer_label_size    IS NULL
    OR consumer_label_option3 IS NULL;


-- ─────────────────────────────────────────────────────────
-- ⑤ variant_code 글로벌 unique 인덱스
-- ─────────────────────────────────────────────────────────
CREATE UNIQUE INDEX IF NOT EXISTS uq_variant_code
  ON product_variants(variant_code)
  WHERE variant_code IS NOT NULL;


-- ─────────────────────────────────────────────────────────
-- 완료 메시지
-- ─────────────────────────────────────────────────────────
DO $$
DECLARE
  v_total       INT;
  v_with_code   INT;
  v_for_sale    INT;
BEGIN
  SELECT COUNT(*) INTO v_total     FROM product_variants;
  SELECT COUNT(*) INTO v_with_code FROM product_variants WHERE variant_code IS NOT NULL;
  SELECT COUNT(*) INTO v_for_sale  FROM product_variants WHERE is_for_sale  IS TRUE;
  RAISE NOTICE '[188] product_variants 6 컬럼 박힘. 전체 % rows, variant_code 박힘 %, is_for_sale=true %.',
    v_total, v_with_code, v_for_sale;
END $$;

COMMIT;
