-- ============================================================
-- 223: 매트릭스 유연 입력 + 월마감(accounting_periods)
--
-- 작성: 2026-07-29
-- 배경: "행 하나 만들려고 거래처+계정과목을 다 입력해야 다음 행이 뜨는"
--   방식이 번거롭다는 피드백 — 11.xlsx의 "정산금"처럼 이 입출금 성격을
--   자유롭게 메모하는 란(적요)만으로 행을 만들고, 거래처/계정과목은
--   나중에 채워도 되게. 대신 완성도 강제는 "마감" 시점으로 이동 —
--   부족한 행이 있으면 그 달을 마감할 수 없음(사장님 결정).
-- 결정: ledger_parties.name 을 NULL 허용(적요만으로 행 생성 가능) +
--   accounting_periods 로 tenant×월 단위 마감 상태 관리.
-- ============================================================

BEGIN;

ALTER TABLE ledger_parties ALTER COLUMN name DROP NOT NULL;

CREATE TABLE IF NOT EXISTS accounting_periods (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  period_month DATE NOT NULL,  -- 항상 그 달 1일, 예: '2026-07-01'
  closed_at    TIMESTAMPTZ,     -- NULL = 열려있음
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, period_month)
);
ALTER TABLE accounting_periods DISABLE ROW LEVEL SECURITY;
CREATE INDEX IF NOT EXISTS idx_accounting_periods_tenant ON accounting_periods(tenant_id, period_month);

DO $$ BEGIN
  RAISE NOTICE '[223] ledger_parties.name NULL 허용 + accounting_periods(월마감) 박힘.';
END $$;

COMMIT;
