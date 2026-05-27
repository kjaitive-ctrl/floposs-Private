-- ============================================================
-- 119: 매입금 보유 거래처에 신규 외상 잡힐 때 자동 paid 마킹 안전망
--
-- 사장 시나리오 (2026-05-05):
--   1. 거래처 입금 → 외상 -100,000 (매입금 보유)
--   2. 그 거래처 신규 주문 출고 처리
--   3. 거래처 외상은 정상 갱신되지만, 신규 주문이 outstanding_amount=0/unpaid
--      로 남음 (매입금에서 차감된 셈인데 paid 마킹 안 됨)
--
-- 109 refresh_order_revenue 의 매입금 자동 충당 분기 (line 297-330)
-- 와 중복되지만, 어떤 경로(미송 출고 신규 derived / sample_convert_batch /
-- 향후 추가될 RPC)에서 충당이 누락될 수 있어 단단한 안전망 추가.
--
-- 발동 조건:
--   - orders.outstanding_amount UPDATE 후
--   - NEW.outstanding_amount > 0 (외상 잡힌 채)
--   - NEW.payment_status <> 'paid'
--   - NEW.status <> 'cancelled'
--   - 거래처 outstanding_balance < 0 (매입금 보유)
--   → 그 주문 자동 paid 마킹
--
-- 안전망:
--   - 109 가 정상 동작한 경로: 109 매입금 충당 → outstanding_amount=0
--     → trigger WHEN 조건 false → 재발동 X (무한 루프 방지)
--   - 113 trigger (cascade_paid_when_balance_zero) 와 다른 테이블/시점 → 충돌 X
--
-- 박제 정합:
--   - credit_apply transaction INSERT 도 함께 → 109 와 동일 박제 보장
--   - 109 정상 동작 경로: 109 가 박제 → trigger WHEN false (outstanding_amount=0)
--     → trigger 가 추가 박제 X → 중복 0
--   - trg_fill_biz_session_id (071) 가 활성 세션 자동 채움 (출고 처리 시점은
--     항상 활성 세션 보장 — 클라이언트 ensureBizOpen 가드)
-- ============================================================

CREATE OR REPLACE FUNCTION public.cascade_paid_when_credit_available()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_balance      NUMERIC;
  v_credit_used  NUMERIC;
BEGIN
  IF NEW.outstanding_amount > 0
    AND NEW.payment_status <> 'paid'
    AND NEW.status <> 'cancelled' THEN

    SELECT outstanding_balance INTO v_balance
    FROM customers
    WHERE id = NEW.customer_id AND tenant_id = NEW.tenant_id;

    IF v_balance < 0 THEN
      -- 충당 금액 = MIN(매입금 절댓값, 새 외상)
      v_credit_used := LEAST(ABS(v_balance), NEW.outstanding_amount);

      UPDATE orders
      SET outstanding_amount = GREATEST(0, NEW.outstanding_amount - v_credit_used),
          paid_amount        = COALESCE(paid_amount, 0) + v_credit_used,
          payment_status     = CASE
            WHEN NEW.outstanding_amount - v_credit_used <= 0 THEN 'paid'
            ELSE 'partial'
          END,
          updated_at         = NOW()
      WHERE id = NEW.id;

      -- 109 와 동일 박제 (입출금 이력/매출리포트 정합 유지)
      INSERT INTO transactions (
        tenant_id, customer_id, source, type, method,
        amount, transaction_date, order_id, description
      ) VALUES (
        NEW.tenant_id, NEW.customer_id, 'credit_apply', 'income', NULL,
        v_credit_used, CURRENT_DATE, NEW.id, '매입금 자동 충당 (trigger)'
      );
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_cascade_paid_when_credit ON orders;

CREATE TRIGGER trg_cascade_paid_when_credit
  AFTER UPDATE OF outstanding_amount ON orders
  FOR EACH ROW
  EXECUTE FUNCTION cascade_paid_when_credit_available();
