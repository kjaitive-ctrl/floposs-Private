-- ============================================================
-- 220: ledger_parties 은행/계좌번호/적요 추가
--
-- 작성: 2026-07-28
-- 배경: 매트릭스 왼쪽 고정열 구성을 거래처/계정과목/은행/계좌번호/적요/
--   합계 순으로 요청받음 (엑셀의 거래처계좌 시트 정보 + 틀고정 관행).
--   은행/계좌번호는 슬롯(retail_suppliers)에 없는 정보라 ledger_parties
--   에 직접 자유텍스트로 보관 — 이체용 참고 메모일 뿐 정산 로직에 안 씀.
-- ============================================================

BEGIN;

ALTER TABLE ledger_parties ADD COLUMN IF NOT EXISTS bank_name TEXT;
ALTER TABLE ledger_parties ADD COLUMN IF NOT EXISTS account_number TEXT;
ALTER TABLE ledger_parties ADD COLUMN IF NOT EXISTS memo TEXT;

DO $$ BEGIN
  RAISE NOTICE '[220] ledger_parties.bank_name/account_number/memo 추가.';
END $$;

COMMIT;
