-- ============================================================
-- 221: 복식부기 전표 (journal_entries/journal_lines) — 1단계
--
-- 작성: 2026-07-29
-- 배경: 사장님이 실제 세무기장용 엑셀(복식부기 시트)을 보여주며 "각 날짜별
--   입출금액은 나중에 복식부기 전표로 출력되어야 한다" — 지금 cash_
--   transactions 는 단식부기(방향+계정 1개)라 이 요구를 못 채움.
-- 결정(1단계 스코프, 사장님 확정):
--   ① 현금 거래는 항상 보통예금이 상대계정이므로 — cash_transactions
--      INSERT/UPDATE 시 트리거로 2~3줄짜리 균형전표를 자동 생성.
--      (출금: 차변=선택계정+부가세대급금 / 대변=보통예금
--       입금: 차변=보통예금 / 대변=선택계정+부가세예수금)
--   ② 현금이 안 오가는 전표(감가상각·재고조정·이월 등)는 수동입력 —
--      앱에서 journal_entries(source_cash_transaction_id=NULL) 직접 생성.
--   ③ 결재라인(담당/팀장/이사/대표)은 스코프 제외(사장님 명시).
-- 계정과목은 기존 P&L 6종(type)에 재무상태표 5분류(gubun: 자산/부채/
--   자본/수익/비용)를 추가로 얹음 — type 은 손익리포트용 그대로 두고,
--   gubun 은 전표의 차변/대변 방향 판단용. 시스템계정(보통예금/부가세
--   대급금/부가세예수금)은 is_system=true, type='자본거래'(손익 제외)로
--   자동 생성.
-- ⚠️ 기존 자본거래 타입 계정은 gubun 기본값 '자산'으로 일괄 백필 —
--   부채성(예수금 등)이면 계정과목 탭에서 직접 고쳐야 함.
-- ============================================================

BEGIN;

ALTER TABLE account_categories ADD COLUMN IF NOT EXISTS gubun TEXT;
ALTER TABLE account_categories ADD COLUMN IF NOT EXISTS is_system BOOLEAN NOT NULL DEFAULT false;

UPDATE account_categories SET gubun = CASE
  WHEN type = '매출' THEN '수익'
  WHEN type = '자본거래' THEN '자산'
  ELSE '비용'
END WHERE gubun IS NULL;

ALTER TABLE account_categories ALTER COLUMN gubun SET NOT NULL;
DO $$ BEGIN
  ALTER TABLE account_categories ADD CONSTRAINT account_categories_gubun_check CHECK (gubun IN ('자산', '부채', '자본', '수익', '비용'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS journal_entries (
  id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  entry_date                  DATE NOT NULL,
  memo                        TEXT,
  source_cash_transaction_id  UUID REFERENCES cash_transactions(id) ON DELETE CASCADE,  -- NULL=수동전표
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE journal_entries DISABLE ROW LEVEL SECURITY;
CREATE INDEX IF NOT EXISTS idx_journal_entries_tenant_date ON journal_entries(tenant_id, entry_date);
CREATE UNIQUE INDEX IF NOT EXISTS idx_journal_entries_source ON journal_entries(source_cash_transaction_id) WHERE source_cash_transaction_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS journal_lines (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entry_id              UUID NOT NULL REFERENCES journal_entries(id) ON DELETE CASCADE,
  tenant_id             UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,  -- 비정규화(조회 단순화)
  entry_date            DATE NOT NULL,                                          -- 비정규화(조회 단순화)
  account_category_id   UUID NOT NULL REFERENCES account_categories(id) ON DELETE RESTRICT,
  counterparty_name     TEXT,
  debit_amount          BIGINT NOT NULL DEFAULT 0,
  credit_amount         BIGINT NOT NULL DEFAULT 0,
  sort_order            INT NOT NULL DEFAULT 0,
  CHECK (debit_amount = 0 OR credit_amount = 0)
);
ALTER TABLE journal_lines DISABLE ROW LEVEL SECURITY;
CREATE INDEX IF NOT EXISTS idx_journal_lines_entry ON journal_lines(entry_id);
CREATE INDEX IF NOT EXISTS idx_journal_lines_tenant_date ON journal_lines(tenant_id, entry_date);

-- 시스템 계정(보통예금/부가세대급금/부가세예수금) find-or-create — tenant당 1개씩.
CREATE OR REPLACE FUNCTION ensure_system_account(p_tenant_id UUID, p_name TEXT, p_gubun TEXT)
RETURNS UUID AS $$
DECLARE v_id UUID;
BEGIN
  SELECT id INTO v_id FROM account_categories WHERE tenant_id = p_tenant_id AND name = p_name AND is_system = true LIMIT 1;
  IF v_id IS NULL THEN
    INSERT INTO account_categories (tenant_id, name, type, gubun, is_system, sort_order)
    VALUES (p_tenant_id, p_name, '자본거래', p_gubun, true, -1)
    RETURNING id INTO v_id;
  END IF;
  RETURN v_id;
END;
$$ LANGUAGE plpgsql;

-- cash_transactions 변경 → 균형전표 자동 재생성. account_category_id 없거나 0원이면 생성 안 함(불균형 방지).
-- DELETE 는 FK(source_cash_transaction_id ON DELETE CASCADE)가 처리 — 트리거는 INSERT/UPDATE만.
CREATE OR REPLACE FUNCTION sync_journal_entry_for_cash_txn() RETURNS TRIGGER AS $$
DECLARE
  v_cash_acc UUID;
  v_vat_acc UUID;
  v_entry_id UUID;
BEGIN
  DELETE FROM journal_entries WHERE source_cash_transaction_id = NEW.id;

  IF NEW.account_category_id IS NULL OR NEW.amount <= 0 THEN
    RETURN NEW;
  END IF;

  v_cash_acc := ensure_system_account(NEW.tenant_id, '보통예금', '자산');

  INSERT INTO journal_entries (tenant_id, entry_date, memo, source_cash_transaction_id)
  VALUES (NEW.tenant_id, NEW.txn_date, NEW.memo, NEW.id)
  RETURNING id INTO v_entry_id;

  IF NEW.direction = 'out' THEN
    INSERT INTO journal_lines (entry_id, tenant_id, entry_date, account_category_id, counterparty_name, debit_amount, credit_amount, sort_order)
    VALUES (v_entry_id, NEW.tenant_id, NEW.txn_date, NEW.account_category_id, NEW.counterparty_name, NEW.supply_amount, 0, 1);
    IF NEW.vat_amount > 0 THEN
      v_vat_acc := ensure_system_account(NEW.tenant_id, '부가세대급금', '자산');
      INSERT INTO journal_lines (entry_id, tenant_id, entry_date, account_category_id, counterparty_name, debit_amount, credit_amount, sort_order)
      VALUES (v_entry_id, NEW.tenant_id, NEW.txn_date, v_vat_acc, NEW.counterparty_name, NEW.vat_amount, 0, 2);
    END IF;
    INSERT INTO journal_lines (entry_id, tenant_id, entry_date, account_category_id, counterparty_name, debit_amount, credit_amount, sort_order)
    VALUES (v_entry_id, NEW.tenant_id, NEW.txn_date, v_cash_acc, NEW.counterparty_name, 0, NEW.amount, 3);
  ELSE
    INSERT INTO journal_lines (entry_id, tenant_id, entry_date, account_category_id, counterparty_name, debit_amount, credit_amount, sort_order)
    VALUES (v_entry_id, NEW.tenant_id, NEW.txn_date, v_cash_acc, NEW.counterparty_name, NEW.amount, 0, 1);
    INSERT INTO journal_lines (entry_id, tenant_id, entry_date, account_category_id, counterparty_name, debit_amount, credit_amount, sort_order)
    VALUES (v_entry_id, NEW.tenant_id, NEW.txn_date, NEW.account_category_id, NEW.counterparty_name, 0, NEW.supply_amount, 2);
    IF NEW.vat_amount > 0 THEN
      v_vat_acc := ensure_system_account(NEW.tenant_id, '부가세예수금', '부채');
      INSERT INTO journal_lines (entry_id, tenant_id, entry_date, account_category_id, counterparty_name, debit_amount, credit_amount, sort_order)
      VALUES (v_entry_id, NEW.tenant_id, NEW.txn_date, v_vat_acc, NEW.counterparty_name, 0, NEW.vat_amount, 3);
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_sync_journal_entry ON cash_transactions;
CREATE TRIGGER trg_sync_journal_entry
AFTER INSERT OR UPDATE ON cash_transactions
FOR EACH ROW EXECUTE FUNCTION sync_journal_entry_for_cash_txn();

-- 이미 입력돼 있던 cash_transactions 소급 전표화 (no-op UPDATE 로 트리거 재사용).
UPDATE cash_transactions SET updated_at = updated_at;

DO $$ BEGIN
  RAISE NOTICE '[221] journal_entries/journal_lines 박힘 + cash_transactions 자동 전표화 트리거 + 기존 데이터 소급 생성 완료.';
END $$;

COMMIT;
