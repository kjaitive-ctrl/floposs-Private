-- ============================================================
-- 098: transactions_source_check 에 'vat_collection' 추가
--
-- 버그:
--   092 의 process_vat_collection RPC 가 source='vat_collection' 박제 시도하나
--   062 의 transactions_source_check 제약에 'vat_collection' 누락.
--   → INSERT 시 check constraint 위반.
--
-- 수정:
--   기존 source 값 전부 + 'vat_collection' 추가 재생성.
-- ============================================================

ALTER TABLE transactions DROP CONSTRAINT IF EXISTS transactions_source_check;

ALTER TABLE transactions ADD CONSTRAINT transactions_source_check
  CHECK (source IN (
    'pos_sale',
    'pos_pending',
    'pos_cancel',
    'pos_payment',
    'shipment',
    'payment',
    'purchase',
    'return',
    'cancel',
    'cancellation',
    'refund',
    'manual',
    'bank_api',
    'credit_apply',
    'vat_collection'
  ));
