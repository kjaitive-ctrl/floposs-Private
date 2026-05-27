-- ============================================================
-- 120: 113 trigger 강화 — 외상 0 자동 paid 마킹 시 transaction 박제 추가
--
-- 사장 정합성 원칙 (2026-05-05):
--   "회계 정합성은 반드시 맞아떨어져야 함. 누락되면 신뢰를 잃음."
--   매입금 충당/외상 자동 정산이 발생할 때마다 transactions 에 박제되어
--   입출금 관리 페이지에서 그 차감 이력이 보여야 함.
--
-- 113 trigger 의 한계:
--   외상 0 도달 시 잔존 미결 주문 일괄 paid 마킹은 했지만 transactions
--   박제는 안 했음. 1원 잔존 같은 안전망 케이스에서 그 정산분이 입출금
--   페이지에 안 보임 → 매입금 충당 audit 누락.
--
-- 강화:
--   각 paid 마킹된 주문마다 transactions(credit_apply, income) INSERT.
--   amount = 그 주문의 outstanding_amount (정산할 잔액).
--
-- 박제 정합:
--   - 109 가 정상 매입금 충당한 케이스 → 외상 0 도달 = 모든 주문 paid 처리됨
--     → 113 trigger 의 WHERE 절 (outstanding_amount > 0) 매치 안 됨 → 박제 추가 X
--   - process_payment FIFO 가 vat 차이 등으로 1원 못 깎은 케이스 → 113 trigger
--     가 그 1원 paid + 박제 → 정합 ✓
--   - 반품/매입자동충당 후 외상 0 도달 → 잔존 unpaid 주문 paid + 박제 ✓
--
-- 077 가드 무관 (orders UPDATE + 활성 세션 transactions INSERT).
-- ============================================================

CREATE OR REPLACE FUNCTION public.cascade_paid_when_balance_zero()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_order RECORD;
BEGIN
  IF OLD.outstanding_balance > 0 AND NEW.outstanding_balance <= 0 THEN
    -- 잔존 미결 주문 각각 박제 + paid 마킹
    FOR v_order IN
      SELECT id, total_amount, COALESCE(paid_amount, 0) AS old_paid, outstanding_amount
      FROM orders
      WHERE customer_id    = NEW.id
        AND tenant_id      = NEW.tenant_id
        AND payment_status <> 'paid'
        AND outstanding_amount > 0
        AND status <> 'cancelled'
      ORDER BY created_at ASC
    LOOP
      -- 1) credit_apply 박제 (입출금 페이지/매출리포트 audit)
      INSERT INTO transactions (
        tenant_id, customer_id, source, type, method,
        amount, transaction_date, order_id, description
      ) VALUES (
        NEW.tenant_id, NEW.id, 'credit_apply', 'income', NULL,
        v_order.outstanding_amount, CURRENT_DATE, v_order.id,
        '외상 0 도달 자동 정산 (안전망)'
      );

      -- 2) 주문 paid 마킹
      UPDATE orders
      SET outstanding_amount = 0,
          paid_amount        = total_amount,
          payment_status     = 'paid',
          updated_at         = NOW()
      WHERE id = v_order.id;
    END LOOP;
  END IF;
  RETURN NEW;
END;
$$;
