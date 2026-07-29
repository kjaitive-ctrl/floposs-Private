-- ============================================================
-- 225: 회계 재설계 (처음부터 다시) — accounts/counterparties/
--   cash_line_items/cash_entries/journal_entries/journal_lines
--
-- 작성: 2026-07-29
-- 배경: 218~224 로 쌓아올린 매트릭스/전표 구조가 그때그때 요구를 땜빵식
--   으로 반영하다 누더기가 됨(사장님 판단) — 전부 버리고 DB부터 다시.
--
-- 핵심 원칙(사장님 확정):
--   ① 입출금 매트릭스 셀 = 통장에 찍힌 실제 숫자 그대로. 부가세/원천징수
--      분해는 여기서 안 함.
--   ② 셀 하나 = 자동으로 단순 2줄 전표 생성. 현금 나감: 차변=해당계정
--      /대변=보통예금(고정). 들어옴: 차변=보통예금/대변=해당계정.
--   ③ 부가세/원천징수 같은 실제 분개는 "후처리" — 전표 화면에서 라인을
--      직접 수정(보통예금 쪽 금액은 안 건드리고 반대쪽만 쪼갬). 확정 전.
--   ④ 매트릭스 행(항목)은 적요만으로 먼저 만들고 계정/거래처는 나중에
--      채워도 됨 + 월과 무관하게 영속(이월). 입금/출금 존만 나뉨.
--   ⑤ 계정과목은 코드체계(100=자산/200=부채/300=자본/400=수익/500=비용,
--      구분 안에서 순번 자동증가) + 거래처는 별도 마스터(예금주 포함).
--   ⑥ 전표마다 번호(entry_no, tenant별 순번) 있어야 함.
--
-- 이전 구조(218~224: account_categories/cash_transactions/ledger_parties/
--   journal_entries/journal_lines/accounting_periods/cash_balance_anchors)
--   는 전부 폐기 — 테스트 단계라 실데이터 없음, 새 스키마로 완전 교체.
-- ============================================================

BEGIN;

-- ── 이전 구조 제거 ──────────────────────────────────────────
DROP TRIGGER IF EXISTS trg_sync_journal_entry ON cash_transactions;
DROP FUNCTION IF EXISTS sync_journal_entry_for_cash_txn();
DROP FUNCTION IF EXISTS ensure_system_account(UUID, TEXT, TEXT);
DROP TABLE IF EXISTS journal_lines CASCADE;
DROP TABLE IF EXISTS journal_entries CASCADE;
DROP TABLE IF EXISTS cash_balance_anchors CASCADE;
DROP TABLE IF EXISTS accounting_periods CASCADE;
DROP TABLE IF EXISTS cash_transactions CASCADE;
DROP TABLE IF EXISTS ledger_parties CASCADE;
DROP TABLE IF EXISTS account_categories CASCADE;

-- ── 계정과목 (코드체계: 100=자산 200=부채 300=자본 400=수익 500=비용) ──
CREATE TABLE accounts (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  code        SMALLINT NOT NULL,
  name        TEXT NOT NULL,
  gubun       TEXT NOT NULL CHECK (gubun IN ('자산', '부채', '자본', '수익', '비용')),
  is_system   BOOLEAN NOT NULL DEFAULT false,  -- 보통예금(고정, 자동생성)
  sort_order  INT NOT NULL DEFAULT 0,
  is_active   BOOLEAN NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, code),
  UNIQUE (tenant_id, name)
);
ALTER TABLE accounts DISABLE ROW LEVEL SECURITY;
CREATE INDEX idx_accounts_tenant ON accounts(tenant_id) WHERE is_active = true;

CREATE OR REPLACE FUNCTION next_account_code(p_tenant_id UUID, p_gubun TEXT) RETURNS SMALLINT AS $$
DECLARE
  v_base SMALLINT := CASE p_gubun
    WHEN '자산' THEN 100 WHEN '부채' THEN 200 WHEN '자본' THEN 300
    WHEN '수익' THEN 400 WHEN '비용' THEN 500 END;
  v_max SMALLINT;
BEGIN
  SELECT COALESCE(MAX(code), v_base) INTO v_max FROM accounts
    WHERE tenant_id = p_tenant_id AND code >= v_base AND code < v_base + 100;
  RETURN GREATEST(v_max, v_base) + 1;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION set_account_code() RETURNS TRIGGER AS $$
BEGIN
  IF NEW.code IS NULL THEN
    NEW.code := next_account_code(NEW.tenant_id, NEW.gubun);
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_set_account_code BEFORE INSERT ON accounts
FOR EACH ROW EXECUTE FUNCTION set_account_code();

-- tenant당 보통예금 1개 find-or-create (모든 현금거래의 고정 상대계정).
CREATE OR REPLACE FUNCTION ensure_cash_account(p_tenant_id UUID) RETURNS UUID AS $$
DECLARE v_id UUID;
BEGIN
  SELECT id INTO v_id FROM accounts WHERE tenant_id = p_tenant_id AND is_system = true LIMIT 1;
  IF v_id IS NULL THEN
    INSERT INTO accounts (tenant_id, name, gubun, is_system, sort_order)
    VALUES (p_tenant_id, '보통예금', '자산', true, -1)
    RETURNING id INTO v_id;
  END IF;
  RETURN v_id;
END;
$$ LANGUAGE plpgsql;

-- ── 거래처 마스터 (예금주 포함) ──────────────────────────────
CREATE TABLE counterparties (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name           TEXT NOT NULL,
  account_holder TEXT,  -- 예금주 (거래처명과 다를 수 있음)
  bank_name      TEXT,
  account_number TEXT,
  memo           TEXT,
  is_active      BOOLEAN NOT NULL DEFAULT true,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, name)
);
ALTER TABLE counterparties DISABLE ROW LEVEL SECURITY;
CREATE INDEX idx_counterparties_tenant ON counterparties(tenant_id) WHERE is_active = true;

-- ── 매트릭스 행 (항목) — 적요만으로 생성, 계정/거래처 나중에, 월 무관 영속 ──
CREATE TABLE cash_line_items (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  direction        TEXT NOT NULL CHECK (direction IN ('in', 'out')),
  account_id       UUID REFERENCES accounts(id) ON DELETE SET NULL,
  counterparty_id  UUID REFERENCES counterparties(id) ON DELETE SET NULL,
  management_tag   TEXT,
  memo             TEXT,  -- 적요 = 항목명 (예: "법인폰대금") — 생성 트리거 필드
  sort_order       INT NOT NULL DEFAULT 0,
  is_active        BOOLEAN NOT NULL DEFAULT true,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE cash_line_items DISABLE ROW LEVEL SECURITY;
CREATE INDEX idx_cash_line_items_tenant ON cash_line_items(tenant_id) WHERE is_active = true;

-- ── 매트릭스 셀 (실제 입출금 한 건, 통장 숫자 그대로) ──────────
CREATE TABLE cash_entries (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  line_item_id  UUID NOT NULL REFERENCES cash_line_items(id) ON DELETE CASCADE,
  txn_date      DATE NOT NULL,
  amount        BIGINT NOT NULL CHECK (amount > 0),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (line_item_id, txn_date)
);
ALTER TABLE cash_entries DISABLE ROW LEVEL SECURITY;
CREATE INDEX idx_cash_entries_tenant_date ON cash_entries(tenant_id, txn_date);

-- ── 전표 (entry_no = tenant별 순번) ──────────────────────────
CREATE TABLE journal_entries (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  entry_no              INT NOT NULL,
  entry_date            DATE NOT NULL,
  memo                  TEXT,
  evidence_type         TEXT,  -- 지출증빙, 후처리에서 채움
  source_cash_entry_id  UUID REFERENCES cash_entries(id) ON DELETE CASCADE,
  is_finalized          BOOLEAN NOT NULL DEFAULT false,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, entry_no)
);
ALTER TABLE journal_entries DISABLE ROW LEVEL SECURITY;
CREATE UNIQUE INDEX idx_journal_entries_source ON journal_entries(source_cash_entry_id) WHERE source_cash_entry_id IS NOT NULL;
CREATE INDEX idx_journal_entries_tenant_date ON journal_entries(tenant_id, entry_date);

CREATE OR REPLACE FUNCTION set_journal_entry_no() RETURNS TRIGGER AS $$
DECLARE v_max INT;
BEGIN
  IF NEW.entry_no IS NULL THEN
    SELECT COALESCE(MAX(entry_no), 0) INTO v_max FROM journal_entries WHERE tenant_id = NEW.tenant_id;
    NEW.entry_no := v_max + 1;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_set_journal_entry_no BEFORE INSERT ON journal_entries
FOR EACH ROW EXECUTE FUNCTION set_journal_entry_no();

-- ── 전표 라인 (차변/대변) ────────────────────────────────────
CREATE TABLE journal_lines (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entry_id         UUID NOT NULL REFERENCES journal_entries(id) ON DELETE CASCADE,
  tenant_id        UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,  -- 비정규화(조회 단순화)
  entry_date       DATE NOT NULL,                                          -- 비정규화(조회 단순화)
  account_id       UUID NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  counterparty_id  UUID REFERENCES counterparties(id) ON DELETE SET NULL,
  debit_amount     BIGINT NOT NULL DEFAULT 0,
  credit_amount    BIGINT NOT NULL DEFAULT 0,
  sort_order       INT NOT NULL DEFAULT 0,
  CHECK (debit_amount = 0 OR credit_amount = 0)
);
ALTER TABLE journal_lines DISABLE ROW LEVEL SECURITY;
CREATE INDEX idx_journal_lines_entry ON journal_lines(entry_id);
CREATE INDEX idx_journal_lines_tenant_date ON journal_lines(tenant_id, entry_date);

-- ── cash_entries → journal_entries/lines 자동생성 (단순 2줄, 분해 없음) ──
CREATE OR REPLACE FUNCTION sync_journal_for_cash_entry() RETURNS TRIGGER AS $$
DECLARE
  v_cash_acc UUID;
  v_entry_id UUID;
  v_li RECORD;
BEGIN
  DELETE FROM journal_entries WHERE source_cash_entry_id = NEW.id;

  SELECT account_id, counterparty_id, direction INTO v_li FROM cash_line_items WHERE id = NEW.line_item_id;
  IF v_li.account_id IS NULL THEN
    RETURN NEW;  -- 계정 미배정 상태면 전표 생성 보류 (불완전 전표 방지)
  END IF;

  v_cash_acc := ensure_cash_account(NEW.tenant_id);

  INSERT INTO journal_entries (tenant_id, entry_date, source_cash_entry_id)
  VALUES (NEW.tenant_id, NEW.txn_date, NEW.id)
  RETURNING id INTO v_entry_id;

  IF v_li.direction = 'out' THEN
    INSERT INTO journal_lines (entry_id, tenant_id, entry_date, account_id, counterparty_id, debit_amount, credit_amount, sort_order)
    VALUES (v_entry_id, NEW.tenant_id, NEW.txn_date, v_li.account_id, v_li.counterparty_id, NEW.amount, 0, 1);
    INSERT INTO journal_lines (entry_id, tenant_id, entry_date, account_id, counterparty_id, debit_amount, credit_amount, sort_order)
    VALUES (v_entry_id, NEW.tenant_id, NEW.txn_date, v_cash_acc, v_li.counterparty_id, 0, NEW.amount, 2);
  ELSE
    INSERT INTO journal_lines (entry_id, tenant_id, entry_date, account_id, counterparty_id, debit_amount, credit_amount, sort_order)
    VALUES (v_entry_id, NEW.tenant_id, NEW.txn_date, v_cash_acc, v_li.counterparty_id, NEW.amount, 0, 1);
    INSERT INTO journal_lines (entry_id, tenant_id, entry_date, account_id, counterparty_id, debit_amount, credit_amount, sort_order)
    VALUES (v_entry_id, NEW.tenant_id, NEW.txn_date, v_li.account_id, v_li.counterparty_id, 0, NEW.amount, 2);
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_sync_journal_for_cash_entry
AFTER INSERT OR UPDATE ON cash_entries
FOR EACH ROW EXECUTE FUNCTION sync_journal_for_cash_entry();

-- line_item 의 계정/거래처가 나중에 채워지거나 바뀌면 그 밑의 모든 cash_entries 를
-- 다시 건드려(no-op UPDATE) 위 트리거가 전표를 새로 생성하게 함.
CREATE OR REPLACE FUNCTION resync_journal_for_line_item() RETURNS TRIGGER AS $$
BEGIN
  IF NEW.account_id IS DISTINCT FROM OLD.account_id OR NEW.counterparty_id IS DISTINCT FROM OLD.counterparty_id THEN
    UPDATE cash_entries SET updated_at = now() WHERE line_item_id = NEW.id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_resync_journal_for_line_item
AFTER UPDATE ON cash_line_items
FOR EACH ROW EXECUTE FUNCTION resync_journal_for_line_item();

DO $$ BEGIN
  RAISE NOTICE '[225] 회계 재설계 완료 — accounts/counterparties/cash_line_items/cash_entries/journal_entries/journal_lines.';
END $$;

COMMIT;
