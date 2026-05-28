-- ============================================================
-- 196: 촬영 모델 레지스트리 (retail tenant 별 자체 모델 풀)
--
-- 작성: 2026-05-28
-- 사장 결정 (2026-05-28 회의):
--   1. 촬영(MD기능) 의 "모델" = 자유 텍스트 X. 등록된 모델 풀에서 선택.
--   2. tenant 별 자체 모델 (cross-tenant 공유 X).
--   3. 활성 모델만 dropdown 노출. 비활성 = 이력 보존 + 노출 X.
--   4. 관리 = retail /dashboard/settings 안 "모델 관리" 서브섹션.
--
-- 향후 컬럼 (마이그 X, 메모만):
--   - pay_amount INT, pay_basis TEXT(day/hour)
--   - tax_type TEXT(invoice/biz_income)
--   - national_id_enc TEXT (암호화/마스킹 필요)
-- ============================================================

BEGIN;

CREATE TABLE IF NOT EXISTS models (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  height      INT,           -- cm
  weight      INT,           -- kg
  top_size    TEXT,          -- "S","M","L","free","44","55" 등 자유
  bottom_size TEXT,          -- "S","26","27" 등
  shoe_size   INT,           -- 한국 표기 mm (230, 245)
  body_type   TEXT,          -- "슬림","표준","글래머" 등 자유
  phone       TEXT,          -- "010-1234-5678"
  is_active   BOOLEAN NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_models_tenant_active
  ON models (tenant_id, is_active);

ALTER TABLE models DISABLE ROW LEVEL SECURITY;

COMMENT ON TABLE  models IS
  '촬영 모델 풀 (tenant 별). retail /dashboard/settings 안 모델 관리. 활성만 ShootModal dropdown 노출.';
COMMENT ON COLUMN models.shoe_size IS '한국 표기 mm (230=230mm). 240, 245, 255 등.';
COMMENT ON COLUMN models.is_active IS 'false 시 ShootModal dropdown 미노출. 이력은 보존.';

-- updated_at 자동
CREATE OR REPLACE FUNCTION models_touch_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_models_updated_at ON models;
CREATE TRIGGER trg_models_updated_at
  BEFORE UPDATE ON models
  FOR EACH ROW EXECUTE FUNCTION models_touch_updated_at();

DO $$
BEGIN
  RAISE NOTICE '[196] models 테이블 박힘.';
END $$;

COMMIT;
