-- ============================================================
-- 211: A/S 임퍼소네이션 감사로그
--
-- 작성: 2026-06-08
-- super_admin 이 retail 매장 계정으로 진입(A/S)한 이벤트 박제.
--   - generateLink(magiclink) 로 비번 변경 없이 세션 빌림 → 진입 시점 1건 INSERT.
--   - ⚠️ 한계: 임퍼 중 개별 쓰기는 매장 명의로 박힘(세션이 진짜 유저). 본 로그는 *진입*을 추적.
--   - 쓰기 허용 범위(사장 결정 2026-06-08) + 상시 배너 + 본 로그로 보완.
-- 신규 테이블 1개 — [[feedback_supabase_new_table_rls]] 대비 DISABLE 명시.
-- ============================================================

BEGIN;

CREATE TABLE IF NOT EXISTS impersonation_logs (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_user_id    UUID,                                              -- 진입한 super_admin auth.users.id
  admin_email      TEXT,
  target_tenant_id UUID REFERENCES tenants(id) ON DELETE SET NULL,    -- 대상 retail 매장
  target_email     TEXT,                                              -- 대상 로그인 이메일(@order-portal.local)
  reason           TEXT,                                              -- (선택) A/S 사유
  started_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE impersonation_logs DISABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS idx_impersonation_logs_target ON impersonation_logs(target_tenant_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_impersonation_logs_admin  ON impersonation_logs(admin_user_id, started_at DESC);

DO $$ BEGIN
  RAISE NOTICE '[211] impersonation_logs 박힘 — A/S 진입 감사로그.';
END $$;

COMMIT;
