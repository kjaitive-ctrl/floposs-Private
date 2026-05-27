-- ============================================================
-- 076: 기존 닫힌 세션 통계 백필
--
-- 운영 DB에는 closed 세션 0건이지만(2026-04-28 기준) dev / 추후 환경
-- 일관성을 위해 idempotent 실행.
--
-- stats_finalized_at IS NULL인 closed 세션만 처리.
-- → 이미 박제된 세션은 건너뜀, 여러 번 실행해도 안전.
-- ============================================================

DO $$
DECLARE
  rec RECORD;
  cnt INT := 0;
BEGIN
  FOR rec IN
    SELECT id FROM biz_sessions
    WHERE status = 'closed' AND stats_finalized_at IS NULL
  LOOP
    PERFORM refresh_biz_session_stats(rec.id);
    cnt := cnt + 1;
  END LOOP;

  RAISE NOTICE '076 backfill: % closed session(s) refreshed', cnt;
END $$;
