-- ============================================================
-- 185: measurement_templates 시스템 시드 추가 — 티셔츠 / 팬츠
--
-- 작성: 2026-05-20
-- 사장 결정 (2026-05-20):
--   /samples SIZE 모달의 카테고리 드롭다운에 임시로 "티셔츠" "팬츠" 두 가지 박음.
--   영구 카테고리 시드 — retail tenant 가 자체 추가/수정은 v2 시점 (자체 templates 박제).
--
-- 기존 184 시드 (상의/하의/원피스/아우터/스커트) 는 그대로 유지.
--
-- 멱등 (ON CONFLICT DO NOTHING)
-- ============================================================

BEGIN;

INSERT INTO measurement_templates (tenant_id, category, field_keys, sort_order)
VALUES
  (NULL, '티셔츠', '["어깨너비","가슴둘레","소매길이","총장"]'::jsonb, 10),
  (NULL, '팬츠',   '["허리둘레","엉덩이둘레","허벅지둘레","밑단너비","총장"]'::jsonb, 11)
ON CONFLICT (category) WHERE tenant_id IS NULL DO NOTHING;

DO $$
DECLARE
  v_count INT;
BEGIN
  SELECT COUNT(*) INTO v_count FROM measurement_templates WHERE tenant_id IS NULL;
  RAISE NOTICE '[185] measurement_templates 시스템 시드 % 개 (티셔츠/팬츠 포함).', v_count;
END $$;

COMMIT;
