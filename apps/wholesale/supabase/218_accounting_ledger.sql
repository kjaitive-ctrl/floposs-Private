-- ============================================================
-- 218: 회계 장부 (retail 신규 탭) — 현금흐름/손익 관리
--
-- 작성: 2026-07-28
-- 배경: 사장님이 쓰던 엑셀 현금관리표(거래처×날짜 와이드 매트릭스)는
--   ①계정과목이 셀 라벨일 뿐 구조화 안 됨 ②그래서 손익 자동계산 불가
--   ③거래처 늘면 컬럼 공간 낭비 ④지출 분석 불가 — 네 문제가 전부
--   "와이드 매트릭스로 저장" 이라는 같은 병목에서 나옴.
-- 결정: 거래를 (날짜, 방향, 계정과목, 거래처, 금액) 롱포맷 한 행으로
--   저장. 일자별 스캔(엑셀의 유일한 장점)은 정렬된 리스트 뷰로,
--   손익/지출분석은 계정과목·거래처 GROUP BY 로 해결.
--   계정과목은 하드코딩 안 함 — tenant 가 직접 만들고 관리(성격=type
--   태그만 골라주면 손익 집계 자동). 대납/가지급금 같은 pass-through
--   성격도 사용자가 type="자본거래" 로 직접 분류 — 시스템은 판단 안 함.
--   매입 거래처는 기존 슬롯 매칭(retail_suppliers) 재사용 — 안 쓰면
--   자유텍스트(counterparty_name) fallback. 은행 계좌는 회사 전체
--   현금 하나로 통합(계좌별 잔액 추적 안 함).
-- 대기(Phase 2): 법인카드 엑셀 업로드(별도 원장, 합계만 지출 반영) /
--   부가세 정산서(공급가·부가세 분리 문서) 자동생성.
-- ⚠️ 신규 테이블 RLS 자동활성 함정 — 직접 DISABLE ([[feedback_supabase_new_table_rls]]).
-- ============================================================

BEGIN;

-- ① 계정과목 마스터 (tenant 가 직접 관리)
CREATE TABLE IF NOT EXISTS account_categories (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  type        TEXT NOT NULL CHECK (type IN ('매출', '매입원가', '인건비', '판관비', '세금과공과', '자본거래')),
  sort_order  INT NOT NULL DEFAULT 0,
  is_active   BOOLEAN NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE account_categories DISABLE ROW LEVEL SECURITY;
CREATE INDEX IF NOT EXISTS idx_account_categories_tenant ON account_categories(tenant_id) WHERE is_active = true;

-- ② 현금 거래 전표 (핵심 원장 — 거래처×날짜 매트릭스 대신 롱포맷 한 행)
CREATE TABLE IF NOT EXISTS cash_transactions (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  txn_date            DATE NOT NULL,
  direction           TEXT NOT NULL CHECK (direction IN ('in', 'out')),
  account_category_id UUID REFERENCES account_categories(id) ON DELETE SET NULL,
  retail_supplier_id  UUID REFERENCES retail_suppliers(id) ON DELETE SET NULL,  -- 사입 거래처 슬롯 매칭(있으면)
  counterparty_name   TEXT,                     -- 거래처/수취인 표시명 (매칭 안 되면 자유텍스트)
  amount              BIGINT NOT NULL,           -- 실제 입출금액(원 단위, 부가세 포함/미포함 통틀어)
  vat_included        BOOLEAN NOT NULL DEFAULT false,  -- amount 에 부가세 포함 여부 체크
  supply_amount       BIGINT NOT NULL,           -- 공급가액 (앱에서 계산해 저장 — vat_included 면 round(amount/1.1))
  vat_amount          BIGINT NOT NULL DEFAULT 0, -- 부가세액 (amount - supply_amount)
  memo                TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE cash_transactions DISABLE ROW LEVEL SECURITY;
CREATE INDEX IF NOT EXISTS idx_cash_transactions_tenant_date ON cash_transactions(tenant_id, txn_date);
CREATE INDEX IF NOT EXISTS idx_cash_transactions_category ON cash_transactions(tenant_id, account_category_id);
CREATE INDEX IF NOT EXISTS idx_cash_transactions_supplier ON cash_transactions(retail_supplier_id) WHERE retail_supplier_id IS NOT NULL;

DO $$ BEGIN
  RAISE NOTICE '[218] account_categories + cash_transactions 박힘 — 회계 장부 v1.';
END $$;

COMMIT;
