-- ============================================================
-- 235: 일정 휴무일(schedule_off_days) — 달력 날짜별 휴무일 지정
--
-- 작성: 2026-11-04
-- 배경: 휴무 요일이 매주 바뀌어 요일 고정 불가. 날짜 헤더 체크박스로 그 날만 음영.
-- 결정:
--   - 휴무일로 지정된 날짜만 row 1건(체크 해제 = row 삭제). 다른 곳에서 참조하지 않는
--     단순 표시용 표시라 소프트삭제 불필요.
-- [[project_retail_work_routines]]
-- ============================================================

BEGIN;

CREATE TABLE IF NOT EXISTS schedule_off_days (
  tenant_id   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  off_date    DATE NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, off_date)
);
ALTER TABLE schedule_off_days DISABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  RAISE NOTICE '[235] schedule_off_days 박힘.';
END $$;

COMMIT;
