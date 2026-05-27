-- ============================================================
-- 097: vat_period_skips GRANT 보강 + PostgREST schema reload
--
-- 증상:
--   페이지에서 "제외" 토글 시 RPC INSERT 는 성공했으나 (SQL Editor 에서 행 확인됨)
--   페이지의 vat_period_skips SELECT 가 빈 결과로 와서 skipped 표시 안 됨.
--
-- 원인 후보:
--   1. PostgREST 가 신규 테이블을 schema cache 에 자동으로 못 잡음
--   2. anon/authenticated role 에 SELECT 권한 미부여
--
-- 처방:
--   GRANT 명시 + NOTIFY 로 schema cache 강제 reload.
-- ============================================================

GRANT SELECT, INSERT, UPDATE, DELETE ON vat_period_skips TO anon, authenticated;

-- PostgREST schema cache reload (운영 적용 즉시 페이지가 새 테이블 인식)
NOTIFY pgrst, 'reload schema';
