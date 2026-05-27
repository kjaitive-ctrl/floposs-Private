-- ============================================================
-- 100: transactions_vat_mode_check 에 'vat_only' 추가
--
-- 버그:
--   092 의 process_vat_collection RPC 가 vat_mode='vat_only' 박제 시도하나
--   schema.sql 의 transactions.vat_mode CHECK 가 ('deferred','included','none')
--   만 허용. → INSERT 시 check 위반.
--
-- 정책:
--   'vat_only' = 그 transaction 의 amount 전액이 부가세 (별도 부가세 정산 입금).
--   기존 3종 + 'vat_only' 추가 재생성.
-- ============================================================

ALTER TABLE transactions DROP CONSTRAINT IF EXISTS transactions_vat_mode_check;

ALTER TABLE transactions ADD CONSTRAINT transactions_vat_mode_check
  CHECK (vat_mode IS NULL OR vat_mode IN (
    'deferred',
    'included',
    'none',
    'vat_only'
  ));
