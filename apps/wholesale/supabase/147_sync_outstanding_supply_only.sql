-- ============================================================
-- 147: 132 sync 공식을 supply-only 로 통일 (외상 = 공급가만)
--
-- 사장 보고 (2026-05-07):
--   1) 청구 결제 입금 시 외상에 부가세 포함되어 표기됨
--      예: 출고 60K → 입금 66K (60K 공급가 + 6K vat) → 외상 -6K (잘못, 0이어야)
--   2) 영수증 전잔이 이전 영수증 당잔과 6K 어긋남 (= VAT 분 차이)
--
-- 원인:
--   132 sync_balance_from_transactions 가 raw `amount` SUM 으로 동기화.
--   089 process_payment 의 supply-only manual UPDATE 가 132 DEFERRED 발동 시 덮어씀.
--   132 가 raw amount 라 vat_amount 만큼 외상이 더 차감됨.
--
-- 사장 모델 (메모리 wholesale_pos_vat_design):
--   외상/매출 = 공급가만. transactions.amount 는 cash flow (vat 포함) 박제, vat_amount 별도 컬럼.
--   132 sync 도 supply-only = (amount - vat_amount) 기준이어야 정합.
--
-- Fix:
--   sync 공식을 모든 source 에 (amount - COALESCE(vat_amount, 0)) 로 통일.
--   대부분 source 는 vat_amount=0 이라 결과 동일. payment/refund 만 차이 발생.
--
-- 영향 받는 source:
--   - shipment: 보통 vat_amount=0 (refresh 가 supply 박제) → 변동 X
--   - return: 보통 vat_amount=0 → 변동 X
--   - payment (income): vat 분리 입금 시 supply 만 차감 ✓
--   - refund (expense): vat 분리 환불 시 supply 만 환원 ✓
--   - credit_apply, purchase: vat_amount=0 → 변동 X
--   - vat_collection: amount=vat_amount → 외상 영향 0 (자연스러움)
--
-- 비파괴:
--   - transactions 자체 안 건드림 (amount/vat_amount 박제 그대로)
--   - 089 manual UPDATE 와 일치 → drift 0
--   - 영수증 박제 시점 customer.outstanding_balance 가 정확 → 전잔/당잔 정합
--
-- Cleanup (기존 데이터):
--   현재 customers.outstanding_balance / orders.outstanding_amount 가 raw amount 기준.
--   새 공식으로 일괄 재계산. 132 sync trigger 가 다음 transaction 마다 자동 정합 보장하지만
--   사장 화면 즉시 정합 위해 1회 강제 동기화.
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

  -- 1) order outstanding_amount 동기화 — supply-only
  IF v_order_id IS NOT NULL THEN
    UPDATE orders
    SET outstanding_amount = (
      SELECT COALESCE(SUM(CASE
        WHEN source = 'shipment' THEN (amount - COALESCE(vat_amount, 0))
        WHEN source = 'return' THEN -(amount - COALESCE(vat_amount, 0))
        WHEN source IN ('payment', 'credit_apply', 'purchase') THEN -(amount - COALESCE(vat_amount, 0))
        WHEN source = 'refund' THEN (amount - COALESCE(vat_amount, 0))
        ELSE 0
      END), 0)
      FROM transactions WHERE order_id = v_order_id
    )
    WHERE id = v_order_id;
  END IF;

  -- 2) customer outstanding_balance 동기화 — supply-only
  IF v_customer_id IS NOT NULL THEN
    UPDATE customers
    SET outstanding_balance = (
      SELECT COALESCE(SUM(CASE
        WHEN source = 'shipment' THEN (amount - COALESCE(vat_amount, 0))
        WHEN source = 'return' THEN -(amount - COALESCE(vat_amount, 0))
        WHEN source IN ('payment', 'credit_apply', 'purchase') THEN -(amount - COALESCE(vat_amount, 0))
        WHEN source = 'refund' THEN (amount - COALESCE(vat_amount, 0))
        ELSE 0
      END), 0)
      FROM transactions WHERE customer_id = v_customer_id
    )
    WHERE id = v_customer_id;
  END IF;

  RETURN COALESCE(NEW, OLD);
END;
$$;


-- ── Cleanup: 기존 outstanding 일괄 재계산 (supply-only 공식 적용) ──
-- 132 sync trigger 가 다음 transaction 부터 자동이지만, 즉시 정합 위해 강제 동기화.
UPDATE customers c
SET outstanding_balance = (
  SELECT COALESCE(SUM(CASE
    WHEN source = 'shipment' THEN (amount - COALESCE(vat_amount, 0))
    WHEN source = 'return' THEN -(amount - COALESCE(vat_amount, 0))
    WHEN source IN ('payment', 'credit_apply', 'purchase') THEN -(amount - COALESCE(vat_amount, 0))
    WHEN source = 'refund' THEN (amount - COALESCE(vat_amount, 0))
    ELSE 0
  END), 0)
  FROM transactions WHERE customer_id = c.id
);

UPDATE orders o
SET outstanding_amount = (
  SELECT COALESCE(SUM(CASE
    WHEN source = 'shipment' THEN (amount - COALESCE(vat_amount, 0))
    WHEN source = 'return' THEN -(amount - COALESCE(vat_amount, 0))
    WHEN source IN ('payment', 'credit_apply', 'purchase') THEN -(amount - COALESCE(vat_amount, 0))
    WHEN source = 'refund' THEN (amount - COALESCE(vat_amount, 0))
    ELSE 0
  END), 0)
  FROM transactions WHERE order_id = o.id
)
WHERE EXISTS (SELECT 1 FROM transactions WHERE order_id = o.id);

-- ── issue_receipt_snapshot 보강: post_balance 도 supply-only ──
-- 109 의 credit 분기는 prev + total_amount (vat 포함) 사용. 외상 = supply only 모델과 어긋남.
-- → credit 분기 supply (total_amount - vat_amount) 로 변경.
-- derived/cash/transfer 분기는 원래 supply 기반이라 변동 X.
CREATE OR REPLACE FUNCTION issue_receipt_snapshot(
  p_order_id     UUID,
  p_prev_balance NUMERIC
)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_order          RECORD;
  v_payment_method TEXT;
  v_receipt_no     TEXT;
  v_seq            INT;
  v_post_balance   NUMERIC;
  v_supply         NUMERIC;
BEGIN
  SELECT id, tenant_id, customer_id, total_amount, vat_amount, payment_method, receipt_no,
         derived_from_order_id, revenue
  INTO v_order FROM orders WHERE id = p_order_id;

  IF NOT FOUND THEN RETURN; END IF;
  IF v_order.receipt_no IS NOT NULL THEN RETURN; END IF;  -- idempotent

  -- 결제수단: 거래처 기본 우선, 없으면 주문값, 폴백 cash
  SELECT default_payment_method INTO v_payment_method
  FROM customers WHERE id = v_order.customer_id;
  v_payment_method := COALESCE(v_payment_method, v_order.payment_method, 'cash');

  -- supply only (vat 분리 정책)
  v_supply := COALESCE(v_order.total_amount, 0) - COALESCE(v_order.vat_amount, 0);

  -- 당잔 계산 (사장 모델 + supply only)
  IF v_order.derived_from_order_id IS NOT NULL THEN
    -- derived 주문: 외상 변동 = revenue (refresh 가 supply 박제)
    v_post_balance := p_prev_balance + COALESCE(v_order.revenue, 0)::NUMERIC;
  ELSIF v_payment_method IN ('cash', 'transfer') THEN
    -- 즉시 입금 가정 → 외상 변동 X
    v_post_balance := p_prev_balance;
  ELSE
    -- credit (외상) → supply 만 누적 (147: vat 분리)
    v_post_balance := p_prev_balance + v_supply;
  END IF;

  -- 영수증 번호: R + YYYYMMDD + 4자리 (tenant 내 일자별)
  SELECT COUNT(*) + 1 INTO v_seq
  FROM orders
  WHERE tenant_id = v_order.tenant_id
    AND receipt_issued_at IS NOT NULL
    AND receipt_issued_at::DATE = CURRENT_DATE;
  v_receipt_no := 'R' || to_char(NOW(), 'YYYYMMDD') || '-' || LPAD(v_seq::text, 4, '0');

  -- 영수증 표시 (사장 vat 분리 모델):
  --   receipt_day_total       = supply (매출 단위 = 외상 누적분)
  --   receipt_payment_amount  = total_amount (실제 결제/청구액 = vat 포함, 통장 출금액)
  --   receipt_post_balance    = prev + supply (외상 잔액 = supply only)
  UPDATE orders SET
    receipt_no              = v_receipt_no,
    receipt_issued_at       = NOW(),
    receipt_prev_balance    = p_prev_balance,
    receipt_day_total       = v_supply,                    -- 147: 매출 단위
    receipt_payment_method  = v_payment_method,
    receipt_payment_amount  = COALESCE(v_order.total_amount, 0),  -- vat 포함 그대로
    receipt_post_balance    = v_post_balance
  WHERE id = p_order_id;
END;
$$;

NOTIFY pgrst, 'reload schema';
