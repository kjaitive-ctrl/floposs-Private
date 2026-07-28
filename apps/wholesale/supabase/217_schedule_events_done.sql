-- ============================================================
-- 217: 일정(schedule_events) 완료 처리
--
-- 작성: 2026-07-28
-- 배경: 일정 목록에서 완료 여부를 표시할 방법이 없음. 완료 체크 시
--   캘린더/목록에서 회색으로 흐리게 보여 "끝난 일정"과 "남은 일정"을
--   한눈에 구분하고 싶음.
-- 결정: is_done boolean 컬럼 추가. work_routines 의 routine_checks(날짜별
--   반복 체크) 와 달리 schedule_events 는 단발/기간 성 일정이라 별도
--   체크 테이블 없이 row 자체에 플래그.
-- [[project_retail_work_routines]]
-- ============================================================

BEGIN;

ALTER TABLE schedule_events ADD COLUMN IF NOT EXISTS is_done BOOLEAN NOT NULL DEFAULT false;

DO $$ BEGIN
  RAISE NOTICE '[217] schedule_events.is_done 추가 — 일정 완료 처리 지원.';
END $$;

COMMIT;
