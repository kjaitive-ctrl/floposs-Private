-- ============================================================
-- 034: 옛 product_variants sort_order 를 variant_code 순으로 재박제
--
-- 작성: 2026-05-29
-- 배경: 마이그 033 의 row_number 박제가 created_at 동률 (PG now() 트랜잭션 시작)
-- → id (UUID v4 random) 보조 정렬 → 임의 순.
-- variant_code 는 진행 시 ORDER BY created_at 으로 발급되어 같은 한계지만,
-- 가장 최근 발급분이 사장님 입력 순에 가까움 (사장이 옵션 입력 후 진행한 직후 상태).
--
-- 본 마이그: variant_code 가 있는 variants 의 sort_order 를 variant_code 순으로 재박제.
-- variant_code 없는 (샘플로 회귀해서 NULL 상태) 는 그대로 유지 (다음 진행 시 재발급).
-- ============================================================

BEGIN;

WITH ranked AS (
  SELECT id,
         row_number() OVER (
           PARTITION BY product_id
           ORDER BY variant_code NULLS LAST, created_at, id
         ) AS rn
  FROM product_variants
  WHERE is_active = true
)
UPDATE product_variants pv
SET sort_order = ranked.rn
FROM ranked
WHERE pv.id = ranked.id;

DO $$
DECLARE
  v_active INT;
  v_with_code INT;
BEGIN
  SELECT COUNT(*) INTO v_active FROM product_variants WHERE is_active = true;
  SELECT COUNT(*) INTO v_with_code FROM product_variants WHERE is_active = true AND variant_code IS NOT NULL;
  RAISE NOTICE '[034] active variants %, variant_code 있는 %개 — sort_order 재박제 완료.', v_active, v_with_code;
END $$;

COMMIT;
