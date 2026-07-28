-- ============================================================
-- 224: 통장 기준잔액 (cash_balance_anchors)
--
-- 작성: 2026-07-29
-- 배경: 원본 현금관리 엑셀의 기초잔액/기말잔액(일별 누적, 통장 실잔액과
--   일치)을 매트릭스에서 놓쳤음 — 이번에 추가. 특정 날짜의 실제 통장
--   잔액 하나(기준점)만 tenant당 1개 저장 — 이후 모든 날짜의 기초/기말
--   잔액은 그 기준점 + cash_transactions 순증감 누적으로 항상 다시
--   계산(고정 저장 X, drift 없음). 기준점을 나중에 다시 맞추면(실제
--   통장과 어긋났을 때) 전체가 그 시점 기준으로 재계산됨.
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
  RAISE NOTICE '[224] cash_balance_anchors 박힘 — 통장 기준잔액.';
END $$;

COMMIT;
