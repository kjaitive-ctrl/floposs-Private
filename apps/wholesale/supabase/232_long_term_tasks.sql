-- ============================================================
-- 232: 장기과제 (retail) — 업무루틴 페이지 좌측 리스트
--
-- 작성: 2026-08-15
-- 컨셉: 날짜 미정 "앞으로 해야 할 일" 목록. 나중에 날짜가 정해지면 일정(schedule_events)으로
--   옮겨 적음 — 장기과제 자체는 캘린더와 무관한 별도의 단순 체크리스트.
-- ============================================================

BEGIN;

CREATE TABLE IF NOT EXISTS long_term_tasks (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  title       TEXT NOT NULL,
  is_done     BOOLEAN NOT NULL DEFAULT false,
  sort_order  INT NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE long_term_tasks DISABLE ROW LEVEL SECURITY;
CREATE INDEX IF NOT EXISTS idx_long_term_tasks_tenant ON long_term_tasks(tenant_id, sort_order);

DO $$ BEGIN
  RAISE NOTICE '[232] 장기과제(long_term_tasks) 박힘.';
END $$;

COMMIT;
