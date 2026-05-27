-- ============================================================
-- 072: orders / transactions.biz_session_id NOT NULL 제약 (Layer 3)
--
-- 선행 조건 (반드시 이 순서):
--   1. 070 partial unique index 적용 (한 tenant 동시 1세션)
--   2. 071 트리거 적용 (NULL이면 자동 채움)
--   3. 기존 NULL row 정리 (scripts/cleanup-test-data.mjs --apply)
--   4. 본 마이그레이션 적용
--   → NULL row가 남아있으면 ALTER TABLE이 실패한다.
--
-- 효과:
--   영업개시 안 된 상태에서 INSERT 자체가 23502로 거부.
--   클라이언트 가드 + 트리거가 모두 뚫려도 DB가 마지막에 막음.
-- ============================================================

ALTER TABLE orders        ALTER COLUMN biz_session_id SET NOT NULL;
ALTER TABLE transactions  ALTER COLUMN biz_session_id SET NOT NULL;
