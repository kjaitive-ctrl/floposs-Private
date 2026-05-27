-- ============================================================
-- 122: 회계 정합성 검증 함수 (read-only)
--
-- 사장 단일 ledger 모델 (2026-05-05):
--   transactions = 원천. orders.outstanding_amount / customers.outstanding_balance
--   = derived (SUM(transactions) 으로 도출).
--
-- 현재 구조: derived 컬럼이 직접 UPDATE 됨. transactions 와 비교하여 정합성 검증.
--
-- 비파괴 read-only. 어떤 데이터도 변경하지 않음. 안심하고 실행 가능.
--
-- 사용:
--   SELECT * FROM audit_order_balance();           -- 모든 주문 정합성
--   SELECT * FROM audit_customer_balance();        -- 모든 거래처 정합성
--   SELECT * FROM audit_balance_summary();         -- 요약
--
-- 결과 해석:
--   diff = 0   → 정합 ✓
--   diff != 0  → 깨진 행. Phase 3 데이터 정리 대상.
-- ============================================================

-- ── 1) 주문별 정합성 ───────────────────────────────────────
-- 주문별 outstanding_amount vs SUM(transactions) 비교
-- 매출 (shipment, receivable) - 결제 (payment, credit_apply, return) = 잔액
CREATE OR REPLACE FUNCTION audit_order_balance()
RETURNS TABLE (
  order_id           UUID,
  order_number       TEXT,
  customer_name      TEXT,
  total_amount       NUMERIC,
  paid_amount        NUMERIC,
  current_outstanding NUMERIC,
  derived_outstanding NUMERIC,
  diff               NUMERIC,
  payment_status     TEXT,
  status             TEXT
)
LANGUAGE sql STABLE SECURITY DEFINER AS $$
  WITH tx_sum AS (
    SELECT
      order_id,
      SUM(CASE
        WHEN source = 'shipment' THEN amount        -- 매출 +
        WHEN source = 'return' THEN -amount         -- 반품 -
        WHEN source IN ('payment', 'credit_apply', 'purchase') THEN -amount  -- 결제/충당 -
        WHEN source = 'refund' THEN amount          -- 환불 + (외상 환원)
        ELSE 0
      END) AS derived_balance
    FROM transactions
    WHERE order_id IS NOT NULL
    GROUP BY order_id
  )
  SELECT
    o.id,
    o.order_number,
    c.company_name,
    o.total_amount,
    o.paid_amount,
    o.outstanding_amount,
    COALESCE(t.derived_balance, 0),
    o.outstanding_amount - COALESCE(t.derived_balance, 0) AS diff,
    o.payment_status,
    o.status
  FROM orders o
  LEFT JOIN customers c ON c.id = o.customer_id
  LEFT JOIN tx_sum t   ON t.order_id = o.id
  WHERE o.status <> 'cancelled'
  ORDER BY ABS(o.outstanding_amount - COALESCE(t.derived_balance, 0)) DESC;
$$;

GRANT EXECUTE ON FUNCTION audit_order_balance() TO authenticated;


-- ── 2) 거래처별 정합성 ─────────────────────────────────────
-- customers.outstanding_balance vs SUM(transactions) 비교
CREATE OR REPLACE FUNCTION audit_customer_balance()
RETURNS TABLE (
  customer_id     UUID,
  customer_name   TEXT,
  current_balance NUMERIC,
  derived_balance NUMERIC,
  diff            NUMERIC,
  tx_count        BIGINT
)
LANGUAGE sql STABLE SECURITY DEFINER AS $$
  WITH tx_sum AS (
    SELECT
      customer_id,
      SUM(CASE
        WHEN source = 'shipment' THEN amount
        WHEN source = 'return' THEN -amount
        WHEN source IN ('payment', 'credit_apply', 'purchase') THEN -amount
        WHEN source = 'refund' THEN amount
        ELSE 0
      END) AS derived_balance,
      COUNT(*) AS tx_count
    FROM transactions
    WHERE customer_id IS NOT NULL
    GROUP BY customer_id
  )
  SELECT
    c.id,
    c.company_name,
    c.outstanding_balance,
    COALESCE(t.derived_balance, 0),
    c.outstanding_balance - COALESCE(t.derived_balance, 0) AS diff,
    COALESCE(t.tx_count, 0)
  FROM customers c
  LEFT JOIN tx_sum t ON t.customer_id = c.id
  WHERE c.is_active = true
  ORDER BY ABS(c.outstanding_balance - COALESCE(t.derived_balance, 0)) DESC;
$$;

GRANT EXECUTE ON FUNCTION audit_customer_balance() TO authenticated;


-- ── 3) 요약 ────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION audit_balance_summary()
RETURNS TABLE (
  scope          TEXT,
  total_rows     BIGINT,
  ok_rows        BIGINT,
  broken_rows    BIGINT,
  total_abs_diff NUMERIC
)
LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT '주문' AS scope,
         COUNT(*) AS total_rows,
         COUNT(*) FILTER (WHERE diff = 0) AS ok_rows,
         COUNT(*) FILTER (WHERE diff <> 0) AS broken_rows,
         COALESCE(SUM(ABS(diff)), 0) AS total_abs_diff
  FROM audit_order_balance()
  UNION ALL
  SELECT '거래처',
         COUNT(*),
         COUNT(*) FILTER (WHERE diff = 0),
         COUNT(*) FILTER (WHERE diff <> 0),
         COALESCE(SUM(ABS(diff)), 0)
  FROM audit_customer_balance();
$$;

GRANT EXECUTE ON FUNCTION audit_balance_summary() TO authenticated;
