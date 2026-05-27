-- ============================================================
-- 152: receipt_payment_amount 도 supply 박제 (사장 vat 분리 일관성)
--
-- 관리자 보고 (2026-05-07):
--   영수증 본문: 단가/금액 = supply (정상), 부가세 = 별도 라인 (정상),
--                당일합계 = supply (정상), 당잔 = supply (정상),
--                **외상청구만 vat 포함 (66,000) — 어긋남**
--
-- 원인: 147 에서 receipt_payment_amount = total_amount (vat 포함) 으로 설계.
--   "실제 통장 출금액 표시용" 의도였으나, vat 분리 모델 (외상=supply, vat 별도) 일관성 깨짐.
--   부가세는 영수증 본문에 별도 표시되므로 "외상청구" 행에 또 포함되면 중복 인지.
--
-- 변경: issue_receipt_snapshot 의 receipt_payment_amount = v_supply (총액 아니라 공급가).
--   당일합계 / 외상청구 / 당잔 모두 supply 일관.
-- ============================================================

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

  SELECT default_payment_method INTO v_payment_method
  FROM customers WHERE id = v_order.customer_id;
  v_payment_method := COALESCE(v_payment_method, v_order.payment_method, 'cash');

  -- supply only (vat 분리 정책)
  v_supply := COALESCE(v_order.total_amount, 0) - COALESCE(v_order.vat_amount, 0);

  -- 당잔 계산
  IF v_order.derived_from_order_id IS NOT NULL THEN
    v_post_balance := p_prev_balance + COALESCE(v_order.revenue, 0)::NUMERIC;
  ELSIF v_payment_method IN ('cash', 'transfer') THEN
    v_post_balance := p_prev_balance;
  ELSE
    v_post_balance := p_prev_balance + v_supply;
  END IF;

  SELECT COUNT(*) + 1 INTO v_seq
  FROM orders
  WHERE tenant_id = v_order.tenant_id
    AND receipt_issued_at IS NOT NULL
    AND receipt_issued_at::DATE = CURRENT_DATE;
  v_receipt_no := 'R' || to_char(NOW(), 'YYYYMMDD') || '-' || LPAD(v_seq::text, 4, '0');

  -- 영수증 표시 (사장 vat 분리 모델 일관):
  --   receipt_day_total       = supply (매출 단위)
  --   receipt_payment_amount  = supply (외상청구/현금금액/통장입금 모두 supply)
  --   receipt_post_balance    = prev + supply (외상 잔액)
  -- vat 는 영수증 본문 별도 라인으로 이미 표시됨 (이중 표시 회피).
  UPDATE orders SET
    receipt_no              = v_receipt_no,
    receipt_issued_at       = NOW(),
    receipt_prev_balance    = p_prev_balance,
    receipt_day_total       = v_supply,
    receipt_payment_method  = v_payment_method,
    receipt_payment_amount  = v_supply,    -- 152: total_amount 아닌 supply
    receipt_post_balance    = v_post_balance
  WHERE id = p_order_id;
END;
$$;


-- ── 기존 박제된 영수증 cleanup — receipt_payment_amount supply 로 정정 ──
-- vat=0 인 영수증은 supply == total_amount 라 변동 X (자연 idempotent).
UPDATE orders
SET receipt_payment_amount = COALESCE(total_amount, 0) - COALESCE(vat_amount, 0)
WHERE receipt_no IS NOT NULL;

NOTIFY pgrst, 'reload schema';
