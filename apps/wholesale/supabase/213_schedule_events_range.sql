-- ============================================================
-- 213: 일정(schedule_events) 기간(여러날짜) 등록 지원
--
-- 작성: 2026-07-08
-- 배경: 지금까지 일정은 하루(event_date)만 등록 가능. 여러 날짜를 한 번에
--   기간으로 등록(예: 7/10~7/12 출장)하고 달력에서 이어진 일정으로 보여야 함.
-- 결정: end_date 컬럼 추가(단발 일정=event_date와 동일값). 한 row = 한 기간.
--   여러 row 로 쪼개지 않음(삭제/수정이 기간 전체 단위로 자연스럽게 되도록).
-- [[project_retail_work_routines]]
-- ============================================================

BEGIN;

ALTER TABLE schedule_events ADD COLUMN IF NOT EXISTS end_date DATE;
UPDATE schedule_events SET end_date = event_date WHERE end_date IS NULL;
ALTER TABLE schedule_events ALTER COLUMN end_date SET NOT NULL;
ALTER TABLE schedule_events ADD CONSTRAINT schedule_events_range_chk CHECK (end_date >= event_date);

-- 기간 겹침 조회(월 범위 등)용 인덱스
CREATE INDEX IF NOT EXISTS idx_schedule_events_tenant_range ON schedule_events(tenant_id, event_date, end_date);

DO $$ BEGIN
  RAISE NOTICE '[213] schedule_events.end_date 추가 — 기간(여러날짜) 일정 등록 지원.';
END $$;

COMMIT;
