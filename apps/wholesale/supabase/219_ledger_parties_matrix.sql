-- ============================================================
-- 219: 거래처 매트릭스 (ledger_parties) — 회계 장부 v1.1
--
-- 작성: 2026-07-28
-- 배경: 218 의 "거래입력=일자순 리스트"는 방향 지적 — 원본 엑셀의 진짜
--   장점은 "한 거래처가 세로 한 행 + 날짜가 가로로 쭉 나열되어 한 줄만
--   보면 스캔 가능"함. 그리고 같은 거래처는 거의 항상 같은 계정과목·
--   같은 방향(입/출금)·같은 부가세 관행으로 반복 거래됨 — 매달 새로
--   고를 필요 없이 한 번 정하면 계속 유지(연속성)되어야 함.
-- 결정: ledger_parties = 월과 무관하게 영속하는 "행" 마스터. 이름 +
--   기본 계정과목 + 기본 방향 + 기본 VAT포함여부를 한 번 정하면 고정.
--   사용자가 명시적으로 지울 때(is_active=false)까지 매달 계속 뜬다.
--   cash_transactions.ledger_party_id 로 (거래처, 날짜) 셀 하나 = 거래
--   하나를 매핑 — 매트릭스 셀 입력이 곧 전표 입력. 부분 유니크 인덱스로
--   같은 거래처·같은 날 중복 셀 생성을 DB 레벨에서 막음(앱에서도
--   select-then-write 로 안전하게 처리, ON CONFLICT 는 partial index라
--   안 씀).
--   반복이 아닌 예외 거래(대납/일회성 등)는 여전히 리스트뷰(ledger_
--   party_id NULL)로 처리 — 매트릭스는 "정형화된 반복", 리스트는 "예외".
-- ⚠️ 신규 테이블 RLS 자동활성 함정 — 직접 DISABLE.
-- ============================================================

BEGIN;

CREATE TABLE IF NOT EXISTS ledger_parties (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name                  TEXT NOT NULL,
  retail_supplier_id    UUID REFERENCES retail_suppliers(id) ON DELETE SET NULL,
  account_category_id   UUID REFERENCES account_categories(id) ON DELETE SET NULL,
  direction             TEXT NOT NULL CHECK (direction IN ('in', 'out')) DEFAULT 'out',
  vat_included_default  BOOLEAN NOT NULL DEFAULT false,
  sort_order            INT NOT NULL DEFAULT 0,
  is_active             BOOLEAN NOT NULL DEFAULT true,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, name)
);
ALTER TABLE ledger_parties DISABLE ROW LEVEL SECURITY;
CREATE INDEX IF NOT EXISTS idx_ledger_parties_tenant ON ledger_parties(tenant_id) WHERE is_active = true;

ALTER TABLE cash_transactions ADD COLUMN IF NOT EXISTS ledger_party_id UUID REFERENCES ledger_parties(id) ON DELETE SET NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_cash_transactions_party_day
  ON cash_transactions(ledger_party_id, txn_date) WHERE ledger_party_id IS NOT NULL;

DO $$ BEGIN
  RAISE NOTICE '[219] ledger_parties 박힘 + cash_transactions.ledger_party_id — 매트릭스 입력 지원.';
END $$;

COMMIT;
