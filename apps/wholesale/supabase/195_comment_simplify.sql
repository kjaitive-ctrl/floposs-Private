-- ============================================================
-- 195: 멘트 단순화 — JSONB form → TEXT 메모
--
-- 작성: 2026-05-28 (재작성: subquery in transform expression 회피)
-- 사장 결정 (2026-05-28 회의):
--   1. 라벨별 input form (194 설계)는 너무 무거움 → 단일 메모(TEXT) 로 단순화.
--   2. tenant 가 starter text 정의 → 신규 멘트 작성 시 자동 prefill.
--   3. 사용자는 자유롭게 편집. 나중에 AI 프롬프트로 그대로 전달 가능.
--
-- 본 마이그 (194 보완 — 임시 컬럼 우회):
--   ALTER COLUMN TYPE USING (...subquery...) = PG 제약 (transform expression 안 subquery 금지).
--   → 표준 우회: 임시 컬럼 추가 → UPDATE 로 변환 → 옛 DROP → RENAME.
--   ① tenants.comment_template  JSONB → TEXT
--   ② products.comment_data     JSONB → TEXT
--   - 옛 JSONB 데이터가 있으면 자연어 텍스트로 변환 (손실 X).
-- ============================================================

BEGIN;


-- ─────────────────────────────────────────────────────────
-- ① tenants.comment_template (JSONB array of labels → TEXT)
--   예: ["원단","착용감","계절감"] → "원단:\n착용감:\n계절감:"
-- ─────────────────────────────────────────────────────────
ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS comment_template_new TEXT NOT NULL DEFAULT '';

UPDATE tenants
SET comment_template_new = COALESCE((
  SELECT string_agg(label || ':', E'\n')
  FROM jsonb_array_elements_text(comment_template) AS label
), '')
WHERE comment_template IS NOT NULL
  AND jsonb_typeof(comment_template) = 'array';

ALTER TABLE tenants DROP COLUMN comment_template;
ALTER TABLE tenants RENAME COLUMN comment_template_new TO comment_template;

COMMENT ON COLUMN tenants.comment_template IS
  '멘트 starter text. 신규 멘트 작성 시 자동 prefill. 예: "원단:\n착용감:\n계절감:". 사용자가 자유 편집.';


-- ─────────────────────────────────────────────────────────
-- ② products.comment_data (JSONB object → TEXT)
--   예: {"원단":"면","착용감":"슬림"} → "원단: 면\n착용감: 슬림"
-- ─────────────────────────────────────────────────────────
ALTER TABLE products
  ADD COLUMN IF NOT EXISTS comment_data_new TEXT NOT NULL DEFAULT '';

UPDATE products
SET comment_data_new = COALESCE((
  SELECT string_agg(key || ': ' || value, E'\n')
  FROM jsonb_each_text(comment_data)
), '')
WHERE comment_data IS NOT NULL
  AND jsonb_typeof(comment_data) = 'object';

ALTER TABLE products DROP COLUMN comment_data;
ALTER TABLE products RENAME COLUMN comment_data_new TO comment_data;

COMMENT ON COLUMN products.comment_data IS
  '상품별 멘트 메모 (TEXT). 초기 자동 prefill = tenants.comment_template. 이후 자유 편집.';


-- ─────────────────────────────────────────────────────────
-- 완료
-- ─────────────────────────────────────────────────────────
DO $$
BEGIN
  RAISE NOTICE '[195] comment_template/comment_data TEXT 전환 완료.';
END $$;

COMMIT;
