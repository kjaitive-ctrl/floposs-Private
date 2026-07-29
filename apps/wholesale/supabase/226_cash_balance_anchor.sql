-- ============================================================
-- 226: 통장 기준잔액 (cash_balance_anchors) — 재설계 스키마용 재추가
--
-- 작성: 2026-07-30
-- 배경: 예금잔액을 맞춰봐야 하므로 기초/기말잔액이 일별로 표기돼야 함.
--   특정 날짜의 실제 통장 잔액 하나만 저장 — 이후 모든 날의 기초/기말
--   잔액은 그 기준점 + cash_entries 순증감 누적으로 매번 다시 계산.
-- ============================================================

BEGIN;

CREATE TABLE IF NOT EXISTS cash_balance_anchors (
  tenant_id   UUID PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  as_of_date  DATE NOT NULL,
  amount      BIGINT NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE cash_balance_anchors DISABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  RAISE NOTICE '[226] cash_balance_anchors 재추가 — 통장 기준잔액.';
END $$;

COMMIT;
