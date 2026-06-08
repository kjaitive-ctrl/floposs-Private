-- ============================================================
-- 209: 카페24 연동 스키마 (retail) — OAuth 토큰 + 카테고리 + 매핑 + export 로그
--
-- 작성: 2026-06 (사장님 카페24 테스트앱 등록 + 도메인 확보 시점)
-- 구조: 멀티테넌트. 각 retail tenant가 자기 카페24 몰을 OAuth 인증 → 토큰 박제.
--   상품 push 시 retail 상품 → cafe24 상품(product_no) 매핑 박제.
-- OAuth/토큰은 전부 서버(api/cafe24/*)에서만 다룸 (client_secret 비밀).
-- [[project_cafe24_export_design]] [[feedback_supabase_new_table_rls]]
-- ============================================================

BEGIN;

-- ① OAuth 토큰 (tenant당 카페24 몰 1개 연결)
CREATE TABLE IF NOT EXISTS tenant_cafe24_tokens (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  retail_tenant_id   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  mall_id            TEXT NOT NULL,              -- 카페24 쇼핑몰 ID ({mall_id}.cafe24api.com)
  access_token       TEXT NOT NULL,
  refresh_token      TEXT NOT NULL,
  expires_at         TIMESTAMPTZ NOT NULL,       -- access 만료 (2h)
  refresh_expires_at TIMESTAMPTZ,                -- refresh 만료 (2주)
  scope              TEXT,
  connected_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (retail_tenant_id)
);
ALTER TABLE tenant_cafe24_tokens DISABLE ROW LEVEL SECURITY;

-- ② 카페24 카테고리 트리 캐시 (sync)
CREATE TABLE IF NOT EXISTS tenant_cafe24_categories (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  retail_tenant_id   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  cafe24_category_no INT NOT NULL,
  parent_no          INT,
  name               TEXT,
  full_path          TEXT,
  synced_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (retail_tenant_id, cafe24_category_no)
);
ALTER TABLE tenant_cafe24_categories DISABLE ROW LEVEL SECURITY;

-- ③ retail 카테고리 → 카페24 카테고리 매핑
CREATE TABLE IF NOT EXISTS tenant_category_mapping (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  retail_tenant_id   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  retail_category    TEXT NOT NULL,
  cafe24_category_no INT NOT NULL,
  UNIQUE (retail_tenant_id, retail_category)
);
ALTER TABLE tenant_category_mapping DISABLE ROW LEVEL SECURITY;

-- ④ export 로그 (push 이력)
CREATE TABLE IF NOT EXISTS cafe24_export_log (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  retail_tenant_id   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  product_id         UUID REFERENCES products(id) ON DELETE SET NULL,
  cafe24_product_no  INT,
  status             TEXT NOT NULL,              -- success / error
  error              TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE cafe24_export_log DISABLE ROW LEVEL SECURITY;
CREATE INDEX IF NOT EXISTS idx_cafe24_export_log ON cafe24_export_log(retail_tenant_id, created_at DESC);

-- ⑤ products 에 카페24 상품번호 박제 (어느 카페24 상품으로 push 됐나)
ALTER TABLE products ADD COLUMN IF NOT EXISTS cafe24_product_no INT;

DO $$ BEGIN
  RAISE NOTICE '[209] 카페24 연동 스키마 박힘 (tokens/categories/mapping/export_log + products.cafe24_product_no).';
END $$;

COMMIT;
