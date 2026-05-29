-- ============================================================
-- 032: product_variants UNIQUE 인덱스에 is_active=true 조건 추가
--
-- 작성: 2026-05-29
-- 사장 (다) 결정 (2026-05-29): chip × = soft delete (is_active=false).
-- 옛 인덱스 (183) 는 is_active 무관 UNIQUE → 옛 inactive 와 새 active 가 같은 키면 충돌.
-- → 인덱스에 is_active=true 조건 추가. inactive 끼리는 충돌 안 함 (어차피 보이지도 않음).
--
-- 본 마이그
--   ① 옛 2축/3축 partial UNIQUE 인덱스 DROP
--   ② is_active=true 조건 추가한 새 인덱스 CREATE
-- ============================================================

BEGIN;

DROP INDEX IF EXISTS uniq_product_variants_2axis;
DROP INDEX IF EXISTS uniq_product_variants_3axis;

-- 2축 partial UNIQUE — option3 NULL 이면서 is_active=true
CREATE UNIQUE INDEX uniq_product_variants_2axis
  ON product_variants (product_id, color, size)
  WHERE option3 IS NULL AND is_active = true;

-- 3축 partial UNIQUE — option3 채워지고 is_active=true
CREATE UNIQUE INDEX uniq_product_variants_3axis
  ON product_variants (product_id, color, size, option3)
  WHERE option3 IS NOT NULL AND is_active = true;

DO $$
DECLARE
  v_dup_active INT;
BEGIN
  -- 새 인덱스 검증: active variants 중 중복 (있으면 안 됨)
  SELECT COUNT(*) INTO v_dup_active FROM (
    SELECT product_id, color, size, option3, COUNT(*) AS c
    FROM product_variants
    WHERE is_active = true
    GROUP BY product_id, color, size, option3
    HAVING COUNT(*) > 1
  ) sub;
  RAISE NOTICE '[032] active variants 중복 % 그룹 (0 이어야 정상).', v_dup_active;
END $$;

COMMIT;
