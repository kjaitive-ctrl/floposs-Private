-- ============================================================
-- 033: product_variants.sort_order 컬럼 추가 + 옛 데이터 row_number 박제
--
-- 작성: 2026-05-29
-- 사장 (sort_order 정공법 GO 2026-05-29):
--   - 옛 정렬 = created_at 인데 PG now() = 트랜잭션 시작 시점 → multi-row INSERT 동률 → 임의 순서.
--   - 1ms 간격 hack 출혈막기 → sort_order INT 명시 박제로 정공법.
--   - 클라이언트 INSERT 시 sort_order 명시. ORDER BY sort_order ASC 로 통일.
--
-- 본 마이그
--   ① sort_order INT 컬럼 추가 (DEFAULT 0)
--   ② 옛 active variants 의 sort_order = product 단위 row_number (created_at, id) 박제
--   ③ 인덱스 추가 (product_id, sort_order)
-- ============================================================

BEGIN;


-- ─────────────────────────────────────────────────────────
-- ① sort_order 컬럼 추가
-- ─────────────────────────────────────────────────────────
ALTER TABLE product_variants
  ADD COLUMN IF NOT EXISTS sort_order INT NOT NULL DEFAULT 0;

COMMENT ON COLUMN product_variants.sort_order IS
  '클라이언트 INSERT 순 보존 박제. created_at 동률 회피 (now() 트랜잭션 시작 시점 한계). ORDER BY sort_order ASC.';


-- ─────────────────────────────────────────────────────────
-- ② 옛 active variants 의 sort_order 박제 (product 단위 row_number)
-- ─────────────────────────────────────────────────────────
-- 옛 데이터는 created_at 이 같아서 임의 순. id 보조 정렬로 결정적 순 박제.
-- inactive variants 도 같이 박제 (나중에 활성화 시 일관성).
WITH ranked AS (
  SELECT id,
         row_number() OVER (PARTITION BY product_id ORDER BY created_at, id) AS rn
  FROM product_variants
)
UPDATE product_variants pv
SET sort_order = ranked.rn
FROM ranked
WHERE pv.id = ranked.id;


-- ─────────────────────────────────────────────────────────
-- ③ 인덱스
-- ─────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_product_variants_sort
  ON product_variants (product_id, sort_order);


-- ─────────────────────────────────────────────────────────
-- 검증
-- ─────────────────────────────────────────────────────────
DO $$
DECLARE
  v_total INT;
  v_default INT;
BEGIN
  SELECT COUNT(*) INTO v_total FROM product_variants;
  SELECT COUNT(*) INTO v_default FROM product_variants WHERE sort_order = 0;
  RAISE NOTICE '[033] product_variants total=%, sort_order=0 잔존 %개 (0 이어야 정상 — 모두 row_number 박제됨).',
    v_total, v_default;
END $$;


COMMIT;
