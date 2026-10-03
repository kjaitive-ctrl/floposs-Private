-- ============================================================
-- 234: 일정 프로젝트(schedule_projects) — 일정 화면을 "주 블록 × 프로젝트 행"으로
--
-- 작성: 2026-10-03
-- 배경: 일정(schedule_events)을 프로젝트별로 나눠 보고 싶음. 월 달력은 그대로
--   일~토 주 단위 줄바꿈, 각 주 블록 안에 프로젝트 행이 들어가 프로젝트별 일정/기간막대 표시.
-- 결정:
--   - schedule_projects 신설(이름/색/순서/기간/메모). 삭제 = is_active=false(소프트) —
--     연결된 일정은 그대로 보존, 복원 가능. [[feedback_soft_delete_persistent_rows]]
--   - schedule_events.project_id 추가(NULL = 미분류). 기존 일정은 미분류로 그대로 보임.
-- [[project_retail_work_routines]]
-- ============================================================

BEGIN;

CREATE TABLE IF NOT EXISTS schedule_projects (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  color       TEXT NOT NULL DEFAULT 'sky',  -- 팔레트 키 (앱 쪽 PROJECT_COLORS)
  sort_order  INT  NOT NULL DEFAULT 0,
  start_date  DATE,
  end_date    DATE,
  memo        TEXT,
  is_active   BOOLEAN NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE schedule_projects DISABLE ROW LEVEL SECURITY;
CREATE INDEX IF NOT EXISTS idx_schedule_projects_tenant ON schedule_projects(tenant_id, is_active, sort_order);

ALTER TABLE schedule_events
  ADD COLUMN IF NOT EXISTS project_id UUID REFERENCES schedule_projects(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_schedule_events_project ON schedule_events(project_id);

DO $$ BEGIN
  RAISE NOTICE '[234] schedule_projects + schedule_events.project_id 박힘.';
END $$;

COMMIT;
