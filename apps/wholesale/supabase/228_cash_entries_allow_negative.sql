-- ============================================================
-- 228: cash_entries 음수 입력 허용 (반제/환입 전표)
--
-- 작성: 2026-07-30
-- 배경: 반제(취소/환입)처럼 그날 셀에 음수를 넣어야 하는 경우가 있음.
--   0은 여전히 "삭제"(빈 칸) 의미 유지, 그 외 음수는 허용.
-- 트리거 보정: 금액이 음수면 차변/대변이 원래 방향의 반대가 되어야
--   실제 회계 의미(반제=현금 환입)가 맞음 — 절대값을 크기로 쓰고
--   부호에 따라 방향을 뒤집도록 sync_journal_for_cash_entry() 수정.
-- ============================================================

BEGIN;

ALTER TABLE cash_entries DROP CONSTRAINT IF EXISTS cash_entries_amount_check;
ALTER TABLE cash_entries ADD CONSTRAINT cash_entries_amount_check CHECK (amount <> 0);

CREATE OR REPLACE FUNCTION sync_journal_for_cash_entry() RETURNS TRIGGER AS $$
DECLARE
  v_cash_acc UUID;
  v_entry_id UUID;
  v_li RECORD;
  v_amt BIGINT;
  v_dir TEXT;
BEGIN
  DELETE FROM journal_entries WHERE source_cash_entry_id = NEW.id;

  SELECT account_id, counterparty_id, direction INTO v_li FROM cash_line_items WHERE id = NEW.line_item_id;
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

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$ BEGIN
  RAISE NOTICE '[228] cash_entries 음수 허용 + 전표 트리거 방향 보정 완료.';
END $$;

COMMIT;
