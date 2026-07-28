-- ============================================================
-- 222: ledger_parties 관리항목/증빙 추가
--
-- 작성: 2026-07-29
-- 배경: 사장님이 직접 그려본 새 매트릭스 초안(11.xlsx 시트'1')을 기준으로
--   맞춤 — 거래처/구분(입금출금)/계정과목/관리항목/은행/계좌번호/증빙/
--   적요/합계 순. 복식부기 시트의 관리항목·지출증빙과 같은 개념.
-- ============================================================

BEGIN;

ALTER TABLE ledger_parties ADD COLUMN IF NOT EXISTS management_tag TEXT;
ALTER TABLE ledger_parties ADD COLUMN IF NOT EXISTS evidence_type TEXT;

DO $$ BEGIN
  RAISE NOTICE '[222] ledger_parties.management_tag/evidence_type 추가.';
END $$;

COMMIT;
