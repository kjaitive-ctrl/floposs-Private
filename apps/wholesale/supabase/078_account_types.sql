-- ============================================================
-- 078: 계정(업종) 타입 메타데이터 테이블
--
-- 배경: wholesale-pos 가 단일 도매 POS 가 아니라 도매/소매/음식점/+@
--      멀티 업종 통합 플랫폼으로 확장. 사이트 분리 없이 단일 로그인
--      포털에서 가입 시 업종 선택 → 해당 업종 dashboard 로 자동 라우팅.
--
-- 정책:
--   - 가입 시점: 업종 라디오 선택 (account_types where is_signup_enabled=true)
--   - 로그인 시점: 선택 없음. users.user_type 으로 자동 분기 (login/page.tsx 기존 로직)
--   - super_admin 이 /admin/account-types 에서 토글/라벨/순서 관리
--   - 신규 업종 추가는 항상 개발자 코드 작업 필요 (가입 폼/API/dashboard 라우트).
--     admin UI 는 코드로 추가된 타입을 노출/숨김 토글하는 역할.
--
-- 매칭:
--   account_types.code  ↔  users.user_type  ↔  tenants.tenant_type
--
-- 적용 안전:
--   - 모든 ALTER 는 IF NOT EXISTS / IF EXISTS 로 멱등.
--   - 운영 데이터: users.user_type / tenants.tenant_type 컬럼은 schema.sql 에
--     누락된 채 운영 DB에 살아있음 (수동 ALTER로 추가됨). 본 마이그레이션이 정착.
-- ============================================================

-- ── 1. account_types 테이블 ──────────────────────────
CREATE TABLE IF NOT EXISTS account_types (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code                TEXT UNIQUE NOT NULL,         -- 'wholesale' / 'retail' / 'restaurant' ...
  label               TEXT NOT NULL,                -- '도매업체' / '소매업체' / '음식점' (가입 라디오 표시)
  description         TEXT,                         -- 가입 라디오 보조 설명
  dashboard_route     TEXT NOT NULL,                -- 로그인 후 진입 경로 (예: '/dashboard', 'RETAIL_SITE_URL/dashboard')
  is_signup_enabled   BOOLEAN NOT NULL DEFAULT true, -- 가입 폼 라디오에 노출 여부
  display_order       INT NOT NULL DEFAULT 0,
  created_at          TIMESTAMPTZ DEFAULT now(),
  updated_at          TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_account_types_signup
  ON account_types (is_signup_enabled, display_order)
  WHERE is_signup_enabled = true;

-- updated_at 자동 갱신
CREATE OR REPLACE FUNCTION account_types_touch_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_account_types_updated_at ON account_types;
CREATE TRIGGER trg_account_types_updated_at
  BEFORE UPDATE ON account_types
  FOR EACH ROW EXECUTE FUNCTION account_types_touch_updated_at();

-- RLS (개발 단계 비활성)
ALTER TABLE account_types DISABLE ROW LEVEL SECURITY;

-- ── 2. 초기 시드 (현재 운영 중인 업종) ────────────────
-- dashboard_route 는 application 레벨에서 해석:
--   '/dashboard' → 그대로 router.push
--   '__retail__' → process.env.NEXT_PUBLIC_RETAIL_SITE_URL + '/dashboard' 로 window.location
INSERT INTO account_types (code, label, description, dashboard_route, is_signup_enabled, display_order) VALUES
  ('wholesale', '도매업체', '의류/잡화 도매업 운영자 — 거래처/재고/주문/정산 관리', '/dashboard', true, 1),
  ('retail',    '소매업체', '도매처에서 샘플 받아 촬영/플랫폼 등록 운영',           '__retail__',  true, 2)
ON CONFLICT (code) DO NOTHING;

-- ── 3. schema.sql 누락 컬럼 정착 (운영 DB엔 이미 존재) ─
-- users.user_type — 어느 업종 사용자인지. account_types.code 와 매칭.
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS user_type TEXT;

-- users.retailer_id — 소매 사용자가 retail_retailers 와 연결되는 FK
-- (tenant_id 는 도매/음식점 등 'tenants' 테이블 쓰는 업종 전용)
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS retailer_id UUID;

-- tenants.tenant_type — 어느 업종 tenant 인지 (도매/음식점 등)
-- 소매는 retail_retailers 별도 테이블이라 tenants 사용 X
ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS tenant_type TEXT;

-- 기존 운영 데이터 보정: tenant_type 누락된 row 는 'wholesale' 로 (기존 로직 호환)
UPDATE tenants SET tenant_type = 'wholesale' WHERE tenant_type IS NULL;

-- 인덱스 (login 분기 쿼리: WHERE email AND user_type)
CREATE INDEX IF NOT EXISTS idx_users_user_type ON users (user_type);

-- ── 4. 코멘트 ────────────────────────────────────────
COMMENT ON TABLE account_types IS
  '업종(가입 선택지) 메타데이터. /admin/account-types 에서 super_admin 관리. code 는 users.user_type 과 매칭.';
COMMENT ON COLUMN account_types.dashboard_route IS
  '로그인 후 진입 경로. ''/dashboard'' 같은 내부 경로 또는 ''__retail__'' 같은 sentinel — 클라이언트에서 해석.';
COMMENT ON COLUMN account_types.is_signup_enabled IS
  '가입 라디오 노출 여부. false 면 신규 가입은 막히지만 기존 사용자 로그인은 정상.';
