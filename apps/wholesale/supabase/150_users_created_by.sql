-- ============================================================
-- 150: users.created_by 컬럼 추가 — 매장 계정 추가 시 생성자 박제
--
-- 사장 요청 (2026-05-07):
--   매장 계정 생성 시 어떤 tenant_admin 이 만들었는지 + 등록일시 박제.
--   admin 계정관리 페이지에서도 같은 정보 표시.
--
-- created_at 은 이미 schema 에 있음 (users.created_at). 등록일시 = 그 컬럼.
-- created_by 는 신규 — 같은 users 테이블 self-reference (생성한 tenant_admin id).
--
-- 비파괴: nullable + ON DELETE SET NULL (생성자가 삭제돼도 박제 보존).
-- ============================================================

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS created_by UUID REFERENCES users(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_users_created_by ON users(created_by);

NOTIFY pgrst, 'reload schema';
