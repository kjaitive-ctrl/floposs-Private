-- ============================================================
-- 143: cascade_paid_when_balance_zero — credit_apply 박제 제거
--
-- 사장 보고 (2026-05-06):
--   외상 10,000 → 입금 10,000 처리 시 결과 -10,000 (2배 차감).
--
-- 원인:
--   120 trigger 가 외상 0 도달 시 잔존 미결 주문 각각에 credit_apply 박제.
--   132 sync trigger 가 transactions SUM 으로 customers.outstanding_balance 동기화 시
--   그 credit_apply 도 SUM 에 포함됨 → 이중 차감.
--
--   흐름:
--     1. process_payment manual UPDATE customers -= 10,000 → outstanding=0
--     2. 120 trigger 발동 → credit_apply -10,000 INSERT
--     3. process_payment transactions(payment, -10,000) INSERT
--     4. COMMIT — 132 trigger SUM = +10,000(shipment) -10,000(credit_apply) -10,000(payment) = -10,000
--
-- 해결:
--   132 sync trigger 가 모든 정합 책임. cascade_paid_when_balance_zero 는 paid 마킹만.
--   audit 추적은 132 가 SUM 으로 자동 정합 → credit_apply 별도 박제 불필요.
--
-- 영향:
--   - 매입금 자동 충당 (109 안 process_payment) 의 명시 credit_apply INSERT 는 그대로 유지
--     (외상이 + 인 상태에서 매입금 일부 차감 케이스 — 입출금 페이지 audit 표시용)
--   - cascade trigger 의 자동 credit_apply 만 제거 (132 와 중복)
-- ============================================================

CREATE OR REPLACE FUNCTION public.cascade_paid_when_balance_zero()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF OLD.outstanding_balance > 0 AND NEW.outstanding_balance <= 0 THEN
    UPDATE orders
    SET outstanding_amount = 0,
        paid_amount        = total_amount,
        payment_status     = 'paid',
        updated_at         = NOW()
    WHERE customer_id    = NEW.id
      AND tenant_id      = NEW.tenant_id
      AND payment_status <> 'paid'
      AND outstanding_amount > 0
      AND status <> 'cancelled';
  END IF;
  RETURN NEW;
END;
$$;

NOTIFY pgrst, 'reload schema';
