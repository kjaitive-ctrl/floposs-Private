-- 영업개시/영업정산 이력 로그
CREATE TABLE business_session_logs (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID NOT NULL REFERENCES tenants(id),
  event_type  TEXT NOT NULL CHECK (event_type IN ('open', 'close')),
  worker_name TEXT NOT NULL,
  cash_amount BIGINT NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX ON business_session_logs(tenant_id, created_at DESC);

ALTER TABLE business_session_logs DISABLE ROW LEVEL SECURITY;
