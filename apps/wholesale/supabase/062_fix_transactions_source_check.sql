-- ============================================================
-- 062: transactions.source CHECK 제약조건 갱신
--
-- 061 마이그레이션의 매입금 자동충당이 source='credit_apply' 행을
-- INSERT 하는데, 기존 transactions_source_check 가 이를 거부.
--
-- 알려진 source 값 + credit_apply 모두 허용하도록 재생성.
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
