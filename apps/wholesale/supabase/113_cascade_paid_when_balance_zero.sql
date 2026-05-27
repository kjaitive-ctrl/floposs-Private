-- ============================================================
-- 113: 거래처 외상 0 도달 시 미결 주문 자동 paid 마킹 trigger
--
-- 사장 정책 (2026-05-05):
--   "외상 잔액이 0이고 출고처리되어 잔액이 있는 주문은 모두 결제완료"
--   = 어떤 경로(입금/반품/매입자동충당)로든 customers.outstanding_balance 가
--     0/음수 도달하면 그 거래처의 미결 주문 모두 paid 마킹.
--
-- 배경:
--   - process_payment FIFO 가 1원 잔존, vat 차이 등으로 일부 주문에
--     outstanding_amount > 0 남기는 케이스에서 결제 버튼 잔존 → 이중결제 가능
--   - 모든 외상 차감 RPC 마다 안전망 코드 추가하면 14곳 수정 + 누락 위험
--   - DB 레벨 trigger 1개로 정합성 보장 (단일 진실 출처)
--
-- 발동 조건: AFTER UPDATE OF outstanding_balance, OLD>0 AND NEW<=0
--   - 외상 + (출고/미송/교환/샘플변환/매입환원/환불): OLD>=0 NEW>0 → 발동 X
--   - 외상 - (입금/반품): 0 도달 시 발동 → 미결 주문 paid 마킹
--   - 음수에서 더 음수: OLD>0 false → 발동 X
--   - 이미 0인데 다시 0 UPDATE: OLD>0 false → 발동 X (멱등)
--
-- 안전망:
--   - status != 'cancelled' (cancelled 주문 부수효과 차단)
--   - paid_amount = total_amount 동시 갱신 (일관성)
--   - 077 가드 무관 (orders UPDATE 만 함, transactions 영향 X)
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

DROP TRIGGER IF EXISTS trg_cascade_paid_when_zero ON customers;

CREATE TRIGGER trg_cascade_paid_when_zero
  AFTER UPDATE OF outstanding_balance ON customers
  FOR EACH ROW
  EXECUTE FUNCTION cascade_paid_when_balance_zero();
