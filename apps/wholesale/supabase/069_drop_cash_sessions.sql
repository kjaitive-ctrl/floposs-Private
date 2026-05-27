-- ============================================================
-- 069: cash_sessions / business_session_logs 폐기
--
-- 배경:
--   - cash_sessions: 영업개시할 때 한 번 INSERT 후 어떤 코드도 안 건드림.
--     정산 필드(cash_in_total/out_total/expected_closing/actual_closing/
--     difference/closed_at/closed_by/memo) 8개 모두 갱신 0회.
--     biz_sessions가 동일한 역할을 더 충실히 수행하므로 폐기.
--   - business_session_logs: 029에서 추가됐지만 어떤 코드도 안 씀. 폐기.
--   - transactions.cash_session_id: 코드 어디서도 INSERT 안 함.
--     운영 DB 75건 모두 NULL 확인 → 컬럼 DROP.
--
-- 선행 조건: 코드에서 cash_sessions / cash_session_id 참조 모두 제거되어 있어야 함.
-- ============================================================

ALTER TABLE transactions
  DROP COLUMN IF EXISTS cash_session_id;

DROP TABLE IF EXISTS cash_sessions;
DROP TABLE IF EXISTS business_session_logs;
