-- ============================================================
-- 074: 영업세션 통계 캐시 스키마 (Stage A · 매출리포트 인프라)
--
-- 배경:
--   매출리포트 = 세션 단위 집계가 메인 view. 지금 영업정산 페이지는
--   매번 orders/transactions/inbound_orders를 fetch해서 클라이언트에서 합산.
--   매 조회마다 전체 재계산은 1만 유저 SaaS 가면 부하 문제.
--
-- 정책:
--   세션 정산 시점에 통계 박제 → 영구 read-only 스냅샷.
--   매출리포트 / 영업정산 페이지(closed 세션)는 이 캐시만 읽음.
--   인밸리데이션 없음 (정산 후 세션은 다시 안 바뀜) → "캐시"보다 "스냅샷".
--
-- 구조 (A3 하이브리드):
--   1. biz_sessions: 스칼라 통계 컬럼 → 세션 리스트 단일 SELECT
--   2. biz_session_customer_stats (1:N) → 거래처별 기간 누적 GROUP BY
--   3. biz_session_product_stats  (1:N) → 상품별 기간 누적 GROUP BY
--
-- 거래처/상품 이름은 박제. 정산 후 사장이 이름 바꾸거나 삭제해도 매출리포트는
-- 정산 시점 그대로. variant/product/customer 삭제 시 ON DELETE SET NULL —
-- stats 행은 남고 id만 끊김.
-- ============================================================

-- ── biz_sessions: 스칼라 통계 컬럼 ──────────────────────────
-- 모두 NULL 허용 (백필 전 기존 closed 세션은 NULL → 076에서 채움)
ALTER TABLE biz_sessions
  ADD COLUMN IF NOT EXISTS sales_count        INTEGER,
  ADD COLUMN IF NOT EXISTS sales_amount       NUMERIC(14,0),
  ADD COLUMN IF NOT EXISTS returns_count      INTEGER,
  ADD COLUMN IF NOT EXISTS returns_amount     NUMERIC(14,0),
  ADD COLUMN IF NOT EXISTS purchase_count     INTEGER,
  ADD COLUMN IF NOT EXISTS purchase_amount    NUMERIC(14,0),
  ADD COLUMN IF NOT EXISTS cash_in_count      INTEGER,
  ADD COLUMN IF NOT EXISTS cash_in_amount     NUMERIC(14,0),
  ADD COLUMN IF NOT EXISTS transfer_in_count  INTEGER,
  ADD COLUMN IF NOT EXISTS transfer_in_amount NUMERIC(14,0),
  ADD COLUMN IF NOT EXISTS credit_count       INTEGER,
  ADD COLUMN IF NOT EXISTS credit_amount      NUMERIC(14,0),
  ADD COLUMN IF NOT EXISTS manual_in_count    INTEGER,
  ADD COLUMN IF NOT EXISTS manual_in_amount   NUMERIC(14,0),
  ADD COLUMN IF NOT EXISTS manual_out_count   INTEGER,
  ADD COLUMN IF NOT EXISTS manual_out_amount  NUMERIC(14,0),
  ADD COLUMN IF NOT EXISTS vat_count          INTEGER,
  ADD COLUMN IF NOT EXISTS vat_total          NUMERIC(14,0),
  ADD COLUMN IF NOT EXISTS inbound_count      INTEGER,
  ADD COLUMN IF NOT EXISTS inbound_amount     NUMERIC(14,0),
  ADD COLUMN IF NOT EXISTS customer_count     INTEGER,         -- 그 세션 unique 거래처 수
  ADD COLUMN IF NOT EXISTS stats_finalized_at TIMESTAMPTZ;     -- 통계 박제 시각 (NULL = 미박제)


-- ── 세션 × 거래처 ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS biz_session_customer_stats (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  biz_session_id  UUID NOT NULL REFERENCES biz_sessions(id) ON DELETE CASCADE,
  tenant_id       UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  customer_id     UUID REFERENCES customers(id) ON DELETE SET NULL,
  customer_name   TEXT NOT NULL,                         -- 박제
  sales_count     INTEGER       NOT NULL DEFAULT 0,
  sales_amount    NUMERIC(14,0) NOT NULL DEFAULT 0,
  returns_count   INTEGER       NOT NULL DEFAULT 0,
  returns_amount  NUMERIC(14,0) NOT NULL DEFAULT 0,
  purchase_count  INTEGER       NOT NULL DEFAULT 0,
  purchase_amount NUMERIC(14,0) NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ DEFAULT now(),
  -- NULLS NOT DISTINCT: customer_id IS NULL인 행도 세션당 1개로 강제 (PG15+)
  UNIQUE NULLS NOT DISTINCT (biz_session_id, customer_id)
);

CREATE INDEX IF NOT EXISTS idx_bscs_tenant_customer
  ON biz_session_customer_stats(tenant_id, customer_id);
CREATE INDEX IF NOT EXISTS idx_bscs_session
  ON biz_session_customer_stats(biz_session_id);


-- ── 세션 × 상품 variant ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS biz_session_product_stats (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  biz_session_id  UUID NOT NULL REFERENCES biz_sessions(id) ON DELETE CASCADE,
  tenant_id       UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  variant_id      UUID REFERENCES product_variants(id) ON DELETE SET NULL,
  product_id      UUID REFERENCES products(id) ON DELETE SET NULL,
  product_name    TEXT NOT NULL,                         -- 박제
  color           TEXT,
  size            TEXT,
  qty             INTEGER       NOT NULL DEFAULT 0,
  amount          NUMERIC(14,0) NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ DEFAULT now(),
  UNIQUE NULLS NOT DISTINCT (biz_session_id, variant_id)
);

CREATE INDEX IF NOT EXISTS idx_bsps_tenant_variant
  ON biz_session_product_stats(tenant_id, variant_id);
CREATE INDEX IF NOT EXISTS idx_bsps_session
  ON biz_session_product_stats(biz_session_id);


-- ── RLS (운영 컨벤션 따라 disable) ──────────────────────────
ALTER TABLE biz_session_customer_stats DISABLE ROW LEVEL SECURITY;
ALTER TABLE biz_session_product_stats  DISABLE ROW LEVEL SECURITY;
