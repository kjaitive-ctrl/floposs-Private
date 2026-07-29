-- ============================================================
-- 227: 회계 신규 테이블 RLS 재비활성화
--
-- 작성: 2026-07-30
-- 배경: "new row violates row-level security policy for table
--   cash_line_items" — 225에서 DISABLE ROW LEVEL SECURITY 를 실행했는데도
--   Supabase 가 새 테이블에 RLS 를 뒤늦게 자동으로 다시 켜는 경우가 있음
--   ([[feedback_supabase_new_table_rls]] 와 동일 패턴). 225/226 에서 만든
--   테이블 전부 다시 꺼줌.
-- ============================================================

BEGIN;

ALTER TABLE accounts DISABLE ROW LEVEL SECURITY;
ALTER TABLE counterparties DISABLE ROW LEVEL SECURITY;
ALTER TABLE cash_line_items DISABLE ROW LEVEL SECURITY;
ALTER TABLE cash_entries DISABLE ROW LEVEL SECURITY;
ALTER TABLE journal_entries DISABLE ROW LEVEL SECURITY;
ALTER TABLE journal_lines DISABLE ROW LEVEL SECURITY;
ALTER TABLE cash_balance_anchors DISABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  RAISE NOTICE '[227] 회계 테이블 RLS 재비활성화 완료.';
END $$;

COMMIT;
