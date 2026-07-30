-- ============================================================
-- 229: 행 단위 부가세 자동분리 + 수동 전표(계상) 지원
--
-- 작성: 2026-07-30
-- 배경: 입출금 매트릭스 셀(cash_entries.amount)은 계속 통장 찍힌 숫자
--   그대로 하나 — 분해 안 함. 대신 그 행(cash_line_items)에 vat_type을
--   달아두면, 그 행에서 자동생성되는 전표(journal_lines)만 공급가/세액
--   으로 쪼개짐(사장님 확정: "행마다 부가세를 구분하면 그 행은 일관
--   되니까"). + 현금 흐름 없는 회계처리(계상)를 위한 수동 전표 작성
--   RPC 추가 — journal_entries/lines 스키마는 225에서 이미 준비됨
--   (source_cash_entry_id nullable), 여기선 잔액검증 + 시스템계정만.
--
-- 이번 라운드 스코프 밖(다음 라운드): 거래처별 부가세 집계 리포트,
-- 거래처↔admin 도매 slot 연결, 월마감 강제(트리거/버튼) — 이번엔
-- accounting_periods 테이블만 다시 만들어두고 강제 로직은 안 붙임.
-- ============================================================

BEGIN;

-- ── 부가세 분류 (행 단위, 월과 무관하게 이 행 전체에 적용) ──────────
ALTER TABLE cash_line_items ADD COLUMN IF NOT EXISTS vat_type TEXT
  CHECK (vat_type IN ('과세', '영세', '면세'));

-- ── 시스템계정 구분자 — is_system 만으로는 어떤 시스템계정인지 구분 안 됨 ──
-- (보통예금 하나뿐이었는데 부가세대급금/예수금이 늘어나서 필요해짐)
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS system_key TEXT
  CHECK (system_key IN ('cash', 'vat_input', 'vat_output'));
UPDATE accounts SET system_key = 'cash' WHERE is_system = true AND system_key IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_accounts_system_key ON accounts(tenant_id, system_key) WHERE system_key IS NOT NULL;

CREATE OR REPLACE FUNCTION ensure_cash_account(p_tenant_id UUID) RETURNS UUID AS $$
DECLARE v_id UUID;
BEGIN
  SELECT id INTO v_id FROM accounts WHERE tenant_id = p_tenant_id AND system_key = 'cash';
  IF v_id IS NULL THEN
    INSERT INTO accounts (tenant_id, name, gubun, is_system, system_key, sort_order)
    VALUES (p_tenant_id, '보통예금', '자산', true, 'cash', -1)
    RETURNING id INTO v_id;
  END IF;
  RETURN v_id;
END;
$$ LANGUAGE plpgsql;

-- 매입/매출 부가세 계정 find-or-create. p_direction 은 실제 현금흐름 방향
-- (반제로 뒤집힌 경우 포함) 기준 — 'out'=매입(부가세대급금,자산), 'in'=매출(부가세예수금,부채).
CREATE OR REPLACE FUNCTION ensure_vat_account(p_tenant_id UUID, p_direction TEXT) RETURNS UUID AS $$
DECLARE
  v_id UUID;
  v_key TEXT := CASE p_direction WHEN 'out' THEN 'vat_input' ELSE 'vat_output' END;
  v_name TEXT := CASE p_direction WHEN 'out' THEN '부가세대급금' ELSE '부가세예수금' END;
  v_gubun TEXT := CASE p_direction WHEN 'out' THEN '자산' ELSE '부채' END;
BEGIN
  SELECT id INTO v_id FROM accounts WHERE tenant_id = p_tenant_id AND system_key = v_key;
  IF v_id IS NULL THEN
    INSERT INTO accounts (tenant_id, name, gubun, is_system, system_key, sort_order)
    VALUES (p_tenant_id, v_name, v_gubun, true, v_key, -1)
    RETURNING id INTO v_id;
  END IF;
  RETURN v_id;
END;
$$ LANGUAGE plpgsql;

-- ── cash_entries → journal 트리거 재작성 (228 로직 위에 vat_type 분기 추가) ──
CREATE OR REPLACE FUNCTION sync_journal_for_cash_entry() RETURNS TRIGGER AS $$
DECLARE
  v_cash_acc UUID;
  v_vat_acc  UUID;
  v_entry_id UUID;
  v_li       RECORD;
  v_amt      BIGINT;
  v_dir      TEXT;
  v_supply   BIGINT;
  v_vat      BIGINT;
BEGIN
  DELETE FROM journal_entries WHERE source_cash_entry_id = NEW.id;

  SELECT account_id, counterparty_id, direction, vat_type INTO v_li FROM cash_line_items WHERE id = NEW.line_item_id;
  IF v_li.account_id IS NULL THEN
    RETURN NEW;  -- 계정 미배정 상태면 전표 생성 보류 (불완전 전표 방지)
  END IF;

  -- 음수면 방향을 뒤집고 절대값을 크기로 사용 (반제/환입 = 실제로는 반대 방향 현금흐름).
  v_amt := ABS(NEW.amount);
  v_dir := CASE WHEN NEW.amount < 0 THEN (CASE v_li.direction WHEN 'out' THEN 'in' ELSE 'out' END) ELSE v_li.direction END;

  v_cash_acc := ensure_cash_account(NEW.tenant_id);

  INSERT INTO journal_entries (tenant_id, entry_date, source_cash_entry_id)
  VALUES (NEW.tenant_id, NEW.txn_date, NEW.id)
  RETURNING id INTO v_entry_id;

  IF v_li.vat_type = '과세' THEN
    v_supply := ROUND(v_amt / 1.1)::BIGINT;
    v_vat := v_amt - v_supply;
    v_vat_acc := ensure_vat_account(NEW.tenant_id, v_dir);

    IF v_dir = 'out' THEN
      INSERT INTO journal_lines (entry_id, tenant_id, entry_date, account_id, counterparty_id, debit_amount, credit_amount, sort_order) VALUES
        (v_entry_id, NEW.tenant_id, NEW.txn_date, v_li.account_id, v_li.counterparty_id, v_supply, 0, 1),
        (v_entry_id, NEW.tenant_id, NEW.txn_date, v_vat_acc, v_li.counterparty_id, v_vat, 0, 2),
        (v_entry_id, NEW.tenant_id, NEW.txn_date, v_cash_acc, v_li.counterparty_id, 0, v_amt, 3);
    ELSE
      INSERT INTO journal_lines (entry_id, tenant_id, entry_date, account_id, counterparty_id, debit_amount, credit_amount, sort_order) VALUES
        (v_entry_id, NEW.tenant_id, NEW.txn_date, v_cash_acc, v_li.counterparty_id, v_amt, 0, 1),
        (v_entry_id, NEW.tenant_id, NEW.txn_date, v_li.account_id, v_li.counterparty_id, 0, v_supply, 2),
        (v_entry_id, NEW.tenant_id, NEW.txn_date, v_vat_acc, v_li.counterparty_id, 0, v_vat, 3);
    END IF;
  ELSE
    IF v_dir = 'out' THEN
      INSERT INTO journal_lines (entry_id, tenant_id, entry_date, account_id, counterparty_id, debit_amount, credit_amount, sort_order)
      VALUES (v_entry_id, NEW.tenant_id, NEW.txn_date, v_li.account_id, v_li.counterparty_id, v_amt, 0, 1);
      INSERT INTO journal_lines (entry_id, tenant_id, entry_date, account_id, counterparty_id, debit_amount, credit_amount, sort_order)
      VALUES (v_entry_id, NEW.tenant_id, NEW.txn_date, v_cash_acc, v_li.counterparty_id, 0, v_amt, 2);
    ELSE
      INSERT INTO journal_lines (entry_id, tenant_id, entry_date, account_id, counterparty_id, debit_amount, credit_amount, sort_order)
      VALUES (v_entry_id, NEW.tenant_id, NEW.txn_date, v_cash_acc, v_li.counterparty_id, v_amt, 0, 1);
      INSERT INTO journal_lines (entry_id, tenant_id, entry_date, account_id, counterparty_id, debit_amount, credit_amount, sort_order)
      VALUES (v_entry_id, NEW.tenant_id, NEW.txn_date, v_li.account_id, v_li.counterparty_id, 0, v_amt, 2);
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ── 월마감 밑작업만 (강제 로직/버튼은 다음 라운드) ──────────────────
CREATE TABLE IF NOT EXISTS accounting_periods (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  period_month DATE NOT NULL,  -- 항상 그 달 1일
  closed_at    TIMESTAMPTZ,     -- NULL = 열려있음
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, period_month)
);
ALTER TABLE accounting_periods DISABLE ROW LEVEL SECURITY;
CREATE INDEX IF NOT EXISTS idx_accounting_periods_tenant ON accounting_periods(tenant_id, period_month);

-- ── 수동 전표(계상) 생성 — 차변/대변 N줄, 잔액(합계 일치) 서버에서 검증 ──
-- p_lines 예: [{"account_id":"...", "counterparty_id":null, "debit_amount":100000, "credit_amount":0}, ...]
CREATE OR REPLACE FUNCTION create_manual_journal_entry(
  p_tenant_id UUID,
  p_entry_date DATE,
  p_memo TEXT,
  p_lines JSONB
) RETURNS UUID AS $$
DECLARE
  v_entry_id   UUID;
  v_debit_sum  BIGINT;
  v_credit_sum BIGINT;
BEGIN
  IF jsonb_array_length(p_lines) < 2 THEN
    RAISE EXCEPTION '전표는 최소 2줄 이상이어야 해요.';
  END IF;

  SELECT COALESCE(SUM((l->>'debit_amount')::BIGINT), 0), COALESCE(SUM((l->>'credit_amount')::BIGINT), 0)
    INTO v_debit_sum, v_credit_sum
    FROM jsonb_array_elements(p_lines) l;

  IF v_debit_sum != v_credit_sum THEN
    RAISE EXCEPTION '차변 합(%)과 대변 합(%)이 일치하지 않아요.', v_debit_sum, v_credit_sum;
  END IF;
  IF v_debit_sum = 0 THEN
    RAISE EXCEPTION '금액이 비어있는 전표는 저장할 수 없어요.';
  END IF;

  INSERT INTO journal_entries (tenant_id, entry_date, memo)
  VALUES (p_tenant_id, p_entry_date, NULLIF(p_memo, ''))
  RETURNING id INTO v_entry_id;

  INSERT INTO journal_lines (entry_id, tenant_id, entry_date, account_id, counterparty_id, debit_amount, credit_amount, sort_order)
  SELECT v_entry_id, p_tenant_id, p_entry_date,
    (l->>'account_id')::UUID,
    NULLIF(l->>'counterparty_id', '')::UUID,
    COALESCE((l->>'debit_amount')::BIGINT, 0),
    COALESCE((l->>'credit_amount')::BIGINT, 0),
    ord - 1
  FROM jsonb_array_elements(p_lines) WITH ORDINALITY AS t(l, ord);

  RETURN v_entry_id;
END;
$$ LANGUAGE plpgsql;

DO $$ BEGIN
  RAISE NOTICE '[229] 부가세 자동분리(vat_type) + 수동 전표 RPC + accounting_periods(밑작업) 반영.';
END $$;

COMMIT;
