-- ============================================================
-- 079: 플랫폼 일반설정 (사업자 정보 등) — 싱글톤 테이블
--
-- 배경: 로그인 페이지 footer 의 사업체 정보 등 사이트 전역 설정값을
--       super_admin 이 /admin/general-settings 에서 편집 가능하게.
--
-- 정책:
--   - 싱글톤 (id=1 CHECK 강제). 한 row 만 존재.
--   - 모든 칼럼 NULL 허용 (값 비어있어도 OK — UI 는 비어있는 라인 자동 숨김).
--   - RLS 비활성 (다른 테이블과 동일, 개발 단계).
--   - login footer 는 anon 으로 읽음 (인증 전 페이지).
-- ============================================================

CREATE TABLE IF NOT EXISTS platform_settings (
  id                    INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  company_name          TEXT,                   -- (주)케이제이리테일
  representative_name   TEXT,                   -- 장성민
  business_number       TEXT,                   -- 854-86-03301
  ecommerce_license     TEXT,                   -- 제2024-서울중구-1787호
  address               TEXT,                   -- 04635 서울특별시 ...
  contact_email         TEXT,                   -- cs@kjretail.com
  updated_at            TIMESTAMPTZ DEFAULT now()
);

-- updated_at 자동 갱신
CREATE OR REPLACE FUNCTION platform_settings_touch_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_platform_settings_updated_at ON platform_settings;
CREATE TRIGGER trg_platform_settings_updated_at
  BEFORE UPDATE ON platform_settings
  FOR EACH ROW EXECUTE FUNCTION platform_settings_touch_updated_at();

-- RLS 비활성
ALTER TABLE platform_settings DISABLE ROW LEVEL SECURITY;

-- 초기 row (현재 login footer 하드코딩 값으로 시드)
INSERT INTO platform_settings (
  id, company_name, representative_name, business_number,
  ecommerce_license, address, contact_email
) VALUES (
  1,
  '(주)케이제이리테일',
  '장성민',
  '854-86-03301',
  '제2024-서울중구-1787호',
  '04635 서울특별시 중구 퇴계로8길 54-8 (회현동1가) 403호',
  'cs@kjretail.com'
)
ON CONFLICT (id) DO NOTHING;

COMMENT ON TABLE platform_settings IS
  '플랫폼 사이트 전역 설정 (사업자 정보 등). super_admin 이 /admin/general-settings 에서 관리. 싱글톤 (id=1).';
