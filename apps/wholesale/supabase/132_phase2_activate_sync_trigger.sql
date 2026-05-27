-- ============================================================
-- 132: Phase 2 활성화 — outstanding SUM 자동 동기화 trigger
--
-- 사장 단일 ledger 모델 (2026-05-05) 의 인프라 활성화:
--   transactions = 원천. orders.outstanding_amount / customers.outstanding_balance
--   은 SUM(transactions) 의 derived. trigger 가 자동 강제 정합.
--
-- 125 의 audit 모드 → 실 동기화 전환:
--   125 trigger 는 drift_log 기록만. 132 가 outstanding 강제 동기화 추가.
--   기존 RPC 의 직접 UPDATE 와 병행 (trigger 가 SUM 으로 마지막에 덮어씀).
--   결과 = RPC 가 정상 동작했으면 같은 값. drift = 0 보장.
--
-- DEFERRED CONSTRAINT TRIGGER:
--   트랜잭션 COMMIT 시점에 1번만 발동. 같은 트랜잭션 안 RPC 의 모든 변경
--   누적 후 마지막 SUM 으로 정합. RPC 의 직접 UPDATE 와 충돌 X.
--
-- 113/120 trigger 와 정합:
--   113 (외상 0 자동 paid 마킹): customers UPDATE → 즉시 발동 (ROW)
--   132 (outstanding 동기화): transactions 변경 → DEFERRED COMMIT 시점
--   순서: RPC INSERT transactions → 132 DEFERRED 큐에 추가 →
--         RPC 가 customers UPDATE → 113 즉시 발동 (orders paid 마킹) →
--         COMMIT 시 132 발동 → SUM 으로 outstanding 동기화 (113 결과 보존)
--   정합 ✓
--
-- 보존 절대 조건:
--   - outstanding 만 동기화. payment_status / paid_amount 는 RPC + 113/120
--   - 영수증 박제 (102 컬럼) 영향 X
--   - 077 가드 (closed 세션 transactions 차단) 무관
--
-- 주의:
--   - 활성화 후 drift_log 가 깨끗 0 유지되어야 정합 신뢰 입증
--   - 만약 drift 발생 = 어떤 RPC 가 outstanding 잘못 갱신 → 분석 필요
-- ============================================================

CREATE OR REPLACE FUNCTION public.sync_balance_from_transactions()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tx_row    RECORD;
  v_order_id  UUID;
  v_customer_id UUID;
BEGIN
  v_tx_row := COALESCE(NEW, OLD);
  v_order_id := v_tx_row.order_id;
  v_customer_id := v_tx_row.customer_id;

  -- 1) order outstanding_amount 동기화
  IF v_order_id IS NOT NULL THEN
    UPDATE orders
    SET outstanding_amount = (
      SELECT COALESCE(SUM(CASE
        WHEN source = 'shipment' THEN amount
        WHEN source = 'return' THEN -amount
        WHEN source IN ('payment', 'credit_apply', 'purchase') THEN -amount
        WHEN source = 'refund' THEN amount
        ELSE 0
      END), 0)
      FROM transactions WHERE order_id = v_order_id
    )
    WHERE id = v_order_id;
  END IF;

  -- 2) customer outstanding_balance 동기화
  IF v_customer_id IS NOT NULL THEN
    UPDATE customers
    SET outstanding_balance = (
      SELECT COALESCE(SUM(CASE
        WHEN source = 'shipment' THEN amount
        WHEN source = 'return' THEN -amount
        WHEN source IN ('payment', 'credit_apply', 'purchase') THEN -amount
        WHEN source = 'refund' THEN amount
        ELSE 0
      END), 0)
      FROM transactions WHERE customer_id = v_customer_id
    )
    WHERE id = v_customer_id;
  END IF;

  RETURN COALESCE(NEW, OLD);
END;
$$;


-- DEFERRED CONSTRAINT TRIGGER (3개: INSERT/UPDATE/DELETE)
DROP TRIGGER IF EXISTS trg_sync_balance_after_tx_ai ON transactions;
DROP TRIGGER IF EXISTS trg_sync_balance_after_tx_au ON transactions;
DROP TRIGGER IF EXISTS trg_sync_balance_after_tx_ad ON transactions;

CREATE CONSTRAINT TRIGGER trg_sync_balance_after_tx_ai
  AFTER INSERT ON transactions
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  EXECUTE FUNCTION sync_balance_from_transactions();

CREATE CONSTRAINT TRIGGER trg_sync_balance_after_tx_au
  AFTER UPDATE ON transactions
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  EXECUTE FUNCTION sync_balance_from_transactions();

CREATE CONSTRAINT TRIGGER trg_sync_balance_after_tx_ad
  AFTER DELETE ON transactions
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  EXECUTE FUNCTION sync_balance_from_transactions();
