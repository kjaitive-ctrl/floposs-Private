-- ============================================================
-- 080: tenants.status — 가입 승인 워크플로우
--
-- 배경: 현재 signup 즉시 활성. super_admin 검토 절차 없이 dashboard 진입.
--       플랫폼 운영 안정성을 위해 가입 → 대기 → 승인 흐름 도입.
--
-- 정책:
--   - status: 'pending' / 'active' / 'suspended'
--   - 신규 가입: 'pending' (admin 승인 대기)
--   - admin 이 /admin/accounts 에서 "승인" → 'active'
--   - admin 이 "정지" → 'suspended' (재승인 가능)
--   - 기존 is_active 컬럼은 유지하되 deprecated. status 가 source of truth.
--     (마이그레이션: is_active=true → status='active', false → 'suspended')
--   - super_admin 계정 (admin@kjretail.com) 의 tenant 는 강제로 'active'
--
-- 영향:
--   - signup route: status='pending' 으로 INSERT
--   - login flow: status 체크 → pending 이면 안내 페이지
--   - admin/accounts: 승인/정지 버튼 + 상태 표시
-- ============================================================

ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'active', 'suspended'));

-- 기존 데이터 마이그레이션 (is_active 기반 백필)
UPDATE tenants SET status = 'active'
  WHERE status = 'pending' AND is_active = true;

UPDATE tenants SET status = 'suspended'
  WHERE status = 'pending' AND is_active = false;

-- 인덱스 (admin 목록 status 필터 / 로그인 분기 빠르게)
CREATE INDEX IF NOT EXISTS idx_tenants_status ON tenants (status);

-- 코멘트
COMMENT ON COLUMN tenants.status IS
  '가입 승인/사용 상태. pending=가입대기, active=정상사용, suspended=정지. signup 시 pending 으로 시작.';
