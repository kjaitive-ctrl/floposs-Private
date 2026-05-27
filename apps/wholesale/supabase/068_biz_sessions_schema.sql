-- ============================================================
-- 068: biz_sessions 테이블 + orders/transactions.biz_session_id 컬럼 박제
--
-- 배경:
--   운영 DB에는 biz_sessions 테이블과 orders/transactions.biz_session_id
--   컬럼이 이미 존재하지만, 마이그레이션 SQL 파일이 누락되어
--   새 환경에 배포 시 코드가 깨짐. 현재 운영 상태를 SQL로 박제한다.
--
--   다음 단계:
--     069: cash_sessions/business_session_logs 폐기
--     070: status='open' 세션 동시 1개 제약 (partial unique index)
--     071: orders/transactions.biz_session_id NOT NULL 제약 (가드 후)
-- ============================================================

-- ── 영업 세션: 영업개시 ~ 영업정산 1회 단위 ─────────────────
CREATE TABLE IF NOT EXISTS biz_sessions (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  opener_name   TEXT NOT NULL,
  opening_cash  NUMERIC(12,0) NOT NULL DEFAULT 0,
  opened_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  closer_name   TEXT,
  closing_cash  NUMERIC(12,0),
  closed_at     TIMESTAMPTZ,
  status        TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed'))
);

CREATE INDEX IF NOT EXISTS idx_biz_sessions_tenant_opened
  ON biz_sessions(tenant_id, opened_at DESC);

-- ── orders / transactions에 biz_session_id 추가 ────────────
ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS biz_session_id UUID REFERENCES biz_sessions(id);

ALTER TABLE transactions
  ADD COLUMN IF NOT EXISTS biz_session_id UUID REFERENCES biz_sessions(id);

CREATE INDEX IF NOT EXISTS idx_orders_biz_session
  ON orders(biz_session_id);

CREATE INDEX IF NOT EXISTS idx_transactions_biz_session
  ON transactions(biz_session_id);

ALTER TABLE biz_sessions DISABLE ROW LEVEL SECURITY;
