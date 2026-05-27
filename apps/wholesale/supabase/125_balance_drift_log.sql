-- ============================================================
-- 125: Phase 2 검증 모드 — balance_drift_log + 자동 검증 trigger
--
-- 사장 단일 ledger 모델 (2026-05-05) 의 첫 인프라:
--   transactions = 원천. orders.outstanding_amount / customers.outstanding_balance
--   = derived. trigger 가 transactions 변경마다 SUM 재계산 후 현재값과 비교.
--
-- 검증 모드 (변경 X):
--   - 운영 RPC 의 직접 UPDATE 그대로 유지
--   - trigger 는 audit 만. 불일치 시 balance_drift_log 행 추가
--   - 사장님이 일정 기간 운영 후 SELECT * FROM balance_drift_log
--   - 정합 입증되면 활성화 모드로 전환 (별도 마이그)
--
-- 위험 0:
--   - 운영 데이터 자체 변경 X
--   - SUM 계산 부담만 (transactions INSERT 마다 1번)
--   - 검증 단계라 일시적 부담 OK
--
-- 보존 절대 조건 (메모리 명시):
--   결제 버튼/모달, 출고/미송/보류/샘플, 영수증 박제, 입출금관리 표시
--   모두 영향 X (운영 RPC 그대로 + trigger 가 read-only)
-- ============================================================

-- ── 1) drift 로그 테이블 ───────────────────────────────────
CREATE TABLE IF NOT EXISTS balance_drift_log (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  detected_at     TIMESTAMPTZ DEFAULT NOW(),
  scope           TEXT NOT NULL,  -- 'order' | 'customer'
  entity_id       UUID NOT NULL,
  entity_label    TEXT,           -- 디버깅용 (order_number 또는 company_name)
  current_balance NUMERIC NOT NULL,
  derived_balance NUMERIC NOT NULL,
  diff            NUMERIC NOT NULL,
  trigger_event   TEXT NOT NULL,  -- 'INSERT' | 'UPDATE' | 'DELETE'
  trigger_source  UUID,           -- 변동 일으킨 transactions.id
  context         JSONB           -- source/type/method/amount 등
);

CREATE INDEX IF NOT EXISTS idx_balance_drift_log_scope_entity
  ON balance_drift_log(scope, entity_id, detected_at DESC);

CREATE INDEX IF NOT EXISTS idx_balance_drift_log_detected
  ON balance_drift_log(detected_at DESC);

GRANT SELECT, INSERT ON balance_drift_log TO authenticated;


-- ── 2) 검증 trigger 함수 ────────────────────────────────────
CREATE OR REPLACE FUNCTION public.audit_balance_drift()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tx_row         RECORD;
  v_event          TEXT;
  v_order_current  NUMERIC;
  v_order_derived  NUMERIC;
  v_order_label    TEXT;
  v_cust_current   NUMERIC;
  v_cust_derived   NUMERIC;
  v_cust_label     TEXT;
  v_context        JSONB;
BEGIN
  v_event := TG_OP;
  v_tx_row := COALESCE(NEW, OLD);

  v_context := jsonb_build_object(
    'source', v_tx_row.source,
    'type',   v_tx_row.type,
    'method', v_tx_row.method,
    'amount', v_tx_row.amount,
    'date',   v_tx_row.transaction_date
  );

  -- 주문 단위 검증 (order_id 가 있는 transactions 만)
  IF v_tx_row.order_id IS NOT NULL THEN
    SELECT outstanding_amount, order_number
    INTO v_order_current, v_order_label
    FROM orders WHERE id = v_tx_row.order_id;

    SELECT COALESCE(SUM(CASE
      WHEN source = 'shipment' THEN amount
      WHEN source = 'return' THEN -amount
      WHEN source IN ('payment', 'credit_apply', 'purchase') THEN -amount
      WHEN source = 'refund' THEN amount
      ELSE 0
    END), 0)
    INTO v_order_derived
    FROM transactions WHERE order_id = v_tx_row.order_id;

    IF v_order_current IS NOT NULL AND v_order_current <> v_order_derived THEN
      INSERT INTO balance_drift_log (
        scope, entity_id, entity_label,
        current_balance, derived_balance, diff,
        trigger_event, trigger_source, context
      ) VALUES (
        'order', v_tx_row.order_id, v_order_label,
        v_order_current, v_order_derived, v_order_current - v_order_derived,
        v_event, v_tx_row.id, v_context
      );
    END IF;
  END IF;

  -- 거래처 단위 검증
  IF v_tx_row.customer_id IS NOT NULL THEN
    SELECT outstanding_balance, company_name
    INTO v_cust_current, v_cust_label
    FROM customers WHERE id = v_tx_row.customer_id;

    SELECT COALESCE(SUM(CASE
      WHEN source = 'shipment' THEN amount
      WHEN source = 'return' THEN -amount
      WHEN source IN ('payment', 'credit_apply', 'purchase') THEN -amount
      WHEN source = 'refund' THEN amount
      ELSE 0
    END), 0)
    INTO v_cust_derived
    FROM transactions WHERE customer_id = v_tx_row.customer_id;

    IF v_cust_current IS NOT NULL AND v_cust_current <> v_cust_derived THEN
      INSERT INTO balance_drift_log (
        scope, entity_id, entity_label,
        current_balance, derived_balance, diff,
        trigger_event, trigger_source, context
      ) VALUES (
        'customer', v_tx_row.customer_id, v_cust_label,
        v_cust_current, v_cust_derived, v_cust_current - v_cust_derived,
        v_event, v_tx_row.id, v_context
      );
    END IF;
  END IF;

  RETURN COALESCE(NEW, OLD);
END;
$$;


-- ── 3) trigger 등록 ────────────────────────────────────────
DROP TRIGGER IF EXISTS trg_audit_balance_drift_ai ON transactions;
DROP TRIGGER IF EXISTS trg_audit_balance_drift_au ON transactions;
DROP TRIGGER IF EXISTS trg_audit_balance_drift_ad ON transactions;

-- DEFERRED CONSTRAINT TRIGGER: 같은 트랜잭션 안 RPC 의 모든 UPDATE 가 끝난 후
-- (트랜잭션 COMMIT 시점) 발동 → orders/customers 잔액 갱신 완료 후 비교 → 정확
CREATE CONSTRAINT TRIGGER trg_audit_balance_drift_ai
  AFTER INSERT ON transactions
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  EXECUTE FUNCTION audit_balance_drift();

CREATE CONSTRAINT TRIGGER trg_audit_balance_drift_au
  AFTER UPDATE ON transactions
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  EXECUTE FUNCTION audit_balance_drift();

CREATE CONSTRAINT TRIGGER trg_audit_balance_drift_ad
  AFTER DELETE ON transactions
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  EXECUTE FUNCTION audit_balance_drift();


-- ── 4) 사장님 검증 SQL (참고) ─────────────────────────────
-- SELECT * FROM balance_drift_log ORDER BY detected_at DESC LIMIT 50;
-- SELECT scope, COUNT(*), SUM(ABS(diff)) FROM balance_drift_log GROUP BY scope;
