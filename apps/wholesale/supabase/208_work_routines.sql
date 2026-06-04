-- ============================================================
-- 208: 업무루틴 + 일정 (retail) — 안건3 외 신규 기능 Phase A
--
-- 작성: 2026-06-02
-- 컨셉: 사장/직원이 업무루틴(2주 사이클 반복 할일) 세팅 → 대시보드가 "오늘 할일"
--   체크리스트로 불러옴(V=완료 박제, 미체크=놓침). + 일정(다이어리/캘린더). 나중 AI 분석.
-- 결정: 탭=메인(세팅) / 대시보드=읽기 · 2주(14일) 사이클 · 담당=라벨(실계정 나중)
--   · 미완료 lazy(체크한 것만 박제, 없으면 놓침) · RLS 나중(지금 모두 보임).
-- ⚠️ 신규 테이블 RLS 자동활성 함정 — INSERT 에러 시 직접 ALTER DISABLE ([[feedback_supabase_new_table_rls]]).
-- ============================================================

BEGIN;

-- ① 업무루틴 (반복 템플릿)
CREATE TABLE IF NOT EXISTS work_routines (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  assignee    TEXT,                       -- 담당 라벨(사장/직원A..). NULL=공용. 실계정 도입 시 매핑(소켓)
  title       TEXT NOT NULL,
  cycle_days  SMALLINT[] NOT NULL DEFAULT '{}',  -- 2주 사이클 반복일(1~14). 매주=N과 N+7 / 격주=한 번
  sort_order  INT NOT NULL DEFAULT 0,
  is_active   BOOLEAN NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE work_routines DISABLE ROW LEVEL SECURITY;
CREATE INDEX IF NOT EXISTS idx_work_routines_tenant ON work_routines(tenant_id) WHERE is_active = true;

-- ② 루틴 완료 박제 (lazy — 체크한 것만. 기록 없음 = 놓침). AI 분석 원천
CREATE TABLE IF NOT EXISTS routine_checks (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  routine_id  UUID NOT NULL REFERENCES work_routines(id) ON DELETE CASCADE,
  check_date  DATE NOT NULL,
  done        BOOLEAN NOT NULL DEFAULT true,
  checked_by  TEXT,                        -- 담당 라벨
  checked_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (routine_id, check_date)          -- 하루 1건
);
ALTER TABLE routine_checks DISABLE ROW LEVEL SECURITY;
CREATE INDEX IF NOT EXISTS idx_routine_checks_date ON routine_checks(routine_id, check_date);

-- ③ 일정/다이어리 (단발 이벤트, 캘린더)
CREATE TABLE IF NOT EXISTS schedule_events (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  assignee    TEXT,
  event_date  DATE NOT NULL,
  title       TEXT NOT NULL,
  memo        TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE schedule_events DISABLE ROW LEVEL SECURITY;
CREATE INDEX IF NOT EXISTS idx_schedule_events_tenant_date ON schedule_events(tenant_id, event_date);

DO $$ BEGIN
  RAISE NOTICE '[208] 업무루틴(work_routines/routine_checks) + 일정(schedule_events) 박힘.';
END $$;

COMMIT;
