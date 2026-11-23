-- ============================================================
-- 241: 트렌드 보드 표 RLS 재비활성화
--
-- 작성: 2026-11-23
-- 배경: 240 에서 DISABLE 했는데도 Supabase 가 새 표 RLS 를 다시 켜서 브라우저 INSERT 가
--   "new row violates row-level security policy" 로 막힘 (227 회계 표와 같은 현상).
--   [[feedback_supabase_new_table_rls]]
-- ============================================================

ALTER TABLE trend_seasons DISABLE ROW LEVEL SECURITY;
ALTER TABLE trend_items   DISABLE ROW LEVEL SECURITY;

SELECT relname, relrowsecurity FROM pg_class WHERE relname IN ('trend_seasons', 'trend_items');
