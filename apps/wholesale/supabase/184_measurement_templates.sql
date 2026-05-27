-- ============================================================
-- 184: 사이즈표 측정항목 템플릿 (measurement_templates) + 시스템 시드
--
-- 작성: 2026-05-20
-- 사장 결정 (2026-05-20 회의):
--   1. 카테고리별 측정항목 다름 (상의=어깨/가슴/소매/총장, 하의=허리/엉덩이/...).
--   2. 시스템 공통 시드 + retail 사장 자체 커스텀 추가 가능 (tenant_id=NULL 공통).
--   3. 박제는 기존 product_measurements (JSONB) 그대로 — 키를 템플릿이 정의.
--   4. UI: 사이즈 × 측정항목 행렬로 입력 (예시: S/M/L × 어깨/가슴/소매/총장).
--
-- 본 마이그
--   ① measurement_templates 신규 테이블
--      tenant_id NULL = 시스템 공통 (모든 tenant 조회 가능)
--      tenant_id 값 = 해당 tenant 자체 커스텀
--   ② 시스템 공통 시드 5개 카테고리 (상의/하의/원피스/아우터/스커트)
--
-- 영향 매트릭스
--   - product_measurements: schema 변경 0 (JSONB 그대로 자유 박제)
--   - wholesale UI: 본 마이그 무관 (wholesale 측엔 사이즈표 UI 미구현 상태)
--   - retail /samples: 신규 — 카테고리 선택 → 템플릿 로드 → 행렬 입력
--
-- 멱등 + BEGIN/COMMIT
-- ============================================================

BEGIN;


-- ─────────────────────────────────────────────────────────
-- ① measurement_templates 테이블
-- ─────────────────────────────────────────────────────────
-- tenant_id NULLABLE — NULL = 시스템 공통 (모든 tenant 사용).
-- (tenant_id, category) UNIQUE — tenant 안에서 카테고리당 1개 템플릿.
-- 시스템 공통도 동일 — NULL + category 조합 1개만.
CREATE TABLE IF NOT EXISTS measurement_templates (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID REFERENCES tenants(id) ON DELETE CASCADE,
  category    TEXT NOT NULL,
  field_keys  JSONB NOT NULL DEFAULT '[]',
  sort_order  INT  DEFAULT 0,
  is_active   BOOLEAN DEFAULT true,
  created_at  TIMESTAMPTZ DEFAULT now(),
  updated_at  TIMESTAMPTZ DEFAULT now()
);

-- UNIQUE — tenant 측 + 시스템 측 따로
-- tenant 측: (tenant_id, category) 1개
CREATE UNIQUE INDEX IF NOT EXISTS uniq_measurement_templates_tenant
  ON measurement_templates (tenant_id, category)
  WHERE tenant_id IS NOT NULL;

-- 시스템 공통: NULL + category 1개
CREATE UNIQUE INDEX IF NOT EXISTS uniq_measurement_templates_system
  ON measurement_templates (category)
  WHERE tenant_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_measurement_templates_category
  ON measurement_templates (category);

ALTER TABLE measurement_templates DISABLE ROW LEVEL SECURITY;

COMMENT ON TABLE  measurement_templates IS
  '사이즈표 카테고리별 측정항목 정의. tenant_id NULL=시스템 공통(모든 tenant 사용 가능). 박제는 product_measurements.measurements JSONB.';
COMMENT ON COLUMN measurement_templates.tenant_id  IS 'NULL=시스템 공통. 값=해당 tenant 자체 커스텀.';
COMMENT ON COLUMN measurement_templates.category   IS '카테고리명. products.category 와 매칭 (UI에서 카테고리 선택 시 템플릿 로드).';
COMMENT ON COLUMN measurement_templates.field_keys IS '측정항목 키 배열. 예: ["어깨너비","가슴둘레","소매길이","총장"]. product_measurements.measurements JSONB 키와 일치.';
COMMENT ON COLUMN measurement_templates.sort_order IS '표시 순서 (UI 정렬용).';


-- ─────────────────────────────────────────────────────────
-- ② 시스템 공통 시드 5개 카테고리
-- ─────────────────────────────────────────────────────────
-- ON CONFLICT 절은 partial unique index 대상 (tenant_id IS NULL).
-- PostgreSQL은 partial index 대상 ON CONFLICT 시 WHERE 절 명시 필요.
INSERT INTO measurement_templates (tenant_id, category, field_keys, sort_order)
VALUES
  (NULL, '상의',   '["어깨너비","가슴둘레","소매길이","총장"]'::jsonb,                   1),
  (NULL, '하의',   '["허리둘레","엉덩이둘레","허벅지둘레","밑단너비","총장"]'::jsonb,    2),
  (NULL, '원피스', '["어깨너비","가슴둘레","허리둘레","총장"]'::jsonb,                   3),
  (NULL, '아우터', '["어깨너비","가슴둘레","소매길이","총장"]'::jsonb,                   4),
  (NULL, '스커트', '["허리둘레","엉덩이둘레","총장"]'::jsonb,                            5)
ON CONFLICT (category) WHERE tenant_id IS NULL DO NOTHING;


-- ─────────────────────────────────────────────────────────
-- 완료 메시지
-- ─────────────────────────────────────────────────────────
DO $$
DECLARE
  v_system_count INT;
  v_tenant_count INT;
BEGIN
  SELECT COUNT(*) INTO v_system_count FROM measurement_templates WHERE tenant_id IS NULL;
  SELECT COUNT(*) INTO v_tenant_count FROM measurement_templates WHERE tenant_id IS NOT NULL;
  RAISE NOTICE '[184] measurement_templates 박힘. 시스템 공통 % 개, tenant 커스텀 % 개.',
    v_system_count, v_tenant_count;
END $$;

COMMIT;
