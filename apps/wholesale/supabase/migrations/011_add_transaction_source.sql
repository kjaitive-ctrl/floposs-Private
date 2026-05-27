-- transactions 테이블에 source 컬럼 추가 (오픈뱅킹 연동 대비)
-- source: 'pos_sale' | 'pos_payment' | 'manual' | 'bank_api'
ALTER TABLE transactions
  ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'pos_sale',
  ADD COLUMN IF NOT EXISTS external_ref TEXT,       -- 은행 거래 고유번호 (중복 방지)
  ADD COLUMN IF NOT EXISTS is_confirmed BOOLEAN NOT NULL DEFAULT true; -- bank_api는 false로 시작 후 확인

CREATE INDEX IF NOT EXISTS idx_transactions_tenant_date
  ON transactions(tenant_id, transaction_date DESC);
CREATE INDEX IF NOT EXISTS idx_transactions_customer
  ON transactions(customer_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_transactions_external_ref
  ON transactions(tenant_id, external_ref) WHERE external_ref IS NOT NULL;
