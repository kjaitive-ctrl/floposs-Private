-- ============================================================
-- 172: issue_receipt_snapshot — derived 분기 vat_in_payment 결정 fix
--
-- 사장 보고 (2026-05-12):
--   "청구거래처 영수증인데 부가세/합계 라인 안 보임. 잔액박스도 supply only."
--
-- 회귀 추적:
--   - 162 (vat ledger 매트릭스): issue_receipt_snapshot 의 derived 분기에서
--     부모 (derived_from_order_id) 의 receipt_vat_in_payment 상속.
--   - 163 (정공법 재설계): staging → derived 모델 도입. derived 부모 = staging.
--     그러나 staging 은 영수증 박제 X → receipt_vat_in_payment = NULL.
--   - 결과: COALESCE(NULL, false) = FALSE → derived 의 vat_in_payment=FALSE 박제.
--   - route.ts 가 receipt_vat_in_payment 박제값 우선 사용 → 부가세/합계 라인 SKIP.
--
-- Fix:
--   derived 분기를 두 경우로 분리:
--   - return / backorder_release (반품/해제): 원영수증 vat_in_payment 상속 + vat 비례 계산 유지
--     (원영수증 = 출고된 정상 영수증. receipt_vat_in_payment 박제 있음)
--   - 그 외 derived (shipment_action / backorder_ship / hold_register 등):
--     derived.vat_amount > 0 으로 판단 (일반 주문과 동일 식)
--
-- 정합 보존:
--   - 반품/해제 vat 비례 계산: 그대로 (원영수증 supply/vat 비율 사용)
--   - 일반 출고 derived: vat_in_payment = (vat_amount > 0)
--   - 표시: vat_in_payment=TRUE → 부가세/합계 라인 + 잔액박스 with_vat 합산
--
-- Backfill:
--   기존 박제된 영수증 중 vat_in_payment 잘못 박제된 행 정정 (반품/해제 제외).
-- ============================================================

BEGIN;

CREATE OR REPLACE FUNCTION issue_receipt_snapshot(
  p_order_id     UUID,
  p_prev_balance NUMERIC
)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_order              RECORD;
  v_payment_method     TEXT;
  v_receipt_no         TEXT;
  v_seq                INT;
  v_vat_rate           NUMERIC;
  v_supply             NUMERIC;
  v_vat                NUMERIC;
  v_total              NUMERIC;
  v_vat_in_payment     BOOLEAN;
  v_payment_amount     NUMERIC;
  v_prev_balance_vat   NUMERIC;
  v_prev_balance_disp  NUMERIC;
  v_post_balance       NUMERIC;
  v_day_total          NUMERIC;
  v_orig_supply        NUMERIC;
  v_orig_vat           NUMERIC;
BEGIN
  SELECT id, tenant_id, customer_id, total_amount, vat_amount, payment_method, receipt_no,
         derived_from_order_id, revenue, order_source
  INTO v_order FROM orders WHERE id = p_order_id;

  IF NOT FOUND THEN RETURN; END IF;
  IF v_order.receipt_no IS NOT NULL THEN RETURN; END IF;

  SELECT default_payment_method INTO v_payment_method
  FROM customers WHERE id = v_order.customer_id;
  v_payment_method := COALESCE(v_payment_method, v_order.payment_method, 'cash');

  SELECT COALESCE(vat_rate, 0.10) INTO v_vat_rate
  FROM tenants WHERE id = v_order.tenant_id;

  -- supply 박제: derived 면 revenue, 일반이면 (total - vat)
  IF v_order.derived_from_order_id IS NOT NULL THEN
    v_supply := COALESCE(v_order.revenue, 0);
  ELSE
    v_supply := COALESCE(v_order.total_amount, 0) - COALESCE(v_order.vat_amount, 0);
  END IF;

  -- ── 172 fix: vat_in_payment + vat 박제 ──
  -- 반품/해제 derived: 원영수증 vat_in_payment 상속 + vat 비례 계산
  --   (원영수증 = 정상 출고된 derived. receipt_vat_in_payment 박제 있음)
  -- 그 외 모든 주문 (일반 + 일반 derived = shipment_action / *_ship / *_register):
  --   derived.vat_amount > 0 으로 판단 (정공법 모델 일관)
  IF v_order.derived_from_order_id IS NOT NULL
     AND v_order.order_source IN ('return', 'backorder_release') THEN
    SELECT COALESCE(receipt_vat_in_payment, false),
           COALESCE(receipt_supply_amount, 0),
           COALESCE(receipt_vat_amount, 0)
    INTO v_vat_in_payment, v_orig_supply, v_orig_vat
    FROM orders WHERE id = v_order.derived_from_order_id;

    IF v_orig_supply <> 0 THEN
      v_vat := ROUND(v_supply * v_orig_vat / v_orig_supply);
    ELSE
      v_vat := ROUND(v_supply * v_vat_rate);
    END IF;
  ELSE
    -- 일반 주문 + 일반 derived: vat_amount > 0 면 vat_in_payment=TRUE
    v_vat_in_payment := COALESCE(v_order.vat_amount, 0) > 0;
    v_vat := ROUND(v_supply * v_vat_rate);
  END IF;

  v_total := v_supply + v_vat;

  -- 결제액: 박제 시점 transactions(payment, credit_apply) supply+vat 합산
  IF v_vat_in_payment THEN
    SELECT COALESCE(SUM(amount), 0) INTO v_payment_amount
    FROM transactions
    WHERE order_id = p_order_id AND source IN ('payment', 'credit_apply');
  ELSE
    SELECT COALESCE(SUM(amount), 0) INTO v_payment_amount
    FROM transactions
    WHERE order_id = p_order_id AND source IN ('payment', 'credit_apply') AND vat_type = 'supply';
  END IF;

  -- prev_balance 표시값: vat_in_payment 면 supply 외상 + vat 외상 / 아니면 supply only
  SELECT COALESCE(outstanding_vat, 0) INTO v_prev_balance_vat
  FROM customers WHERE id = v_order.customer_id;

  v_prev_balance_disp := CASE
    WHEN v_vat_in_payment THEN p_prev_balance + v_prev_balance_vat
    ELSE p_prev_balance
  END;

  -- 매트릭스 Row 6: 영수증 전잔/당일/당잔 = vat_in_payment 면 with_vat / 아니면 supply only
  v_day_total := CASE WHEN v_vat_in_payment THEN v_total ELSE v_supply END;
  v_post_balance := v_prev_balance_disp + v_day_total - v_payment_amount;

  SELECT COUNT(*) + 1 INTO v_seq
  FROM orders
  WHERE tenant_id = v_order.tenant_id
    AND receipt_issued_at IS NOT NULL
    AND receipt_issued_at::DATE = CURRENT_DATE;
  v_receipt_no := 'R' || to_char(NOW(), 'YYYYMMDD') || '-' || LPAD(v_seq::text, 4, '0');

  UPDATE orders SET
    receipt_no              = v_receipt_no,
    receipt_issued_at       = NOW(),
    receipt_supply_amount   = v_supply,
    receipt_vat_amount      = v_vat,
    receipt_total_amount    = v_total,
    receipt_vat_in_payment  = v_vat_in_payment,
    receipt_prev_balance    = v_prev_balance_disp,
    receipt_day_total       = v_day_total,
    receipt_payment_method  = v_payment_method,
    receipt_payment_amount  = v_payment_amount,
    receipt_post_balance    = v_post_balance
  WHERE id = p_order_id;
END;
$$;

-- ── Backfill: 기존 박제된 영수증 중 vat_in_payment 잘못 박제된 행 정정 ──
-- 반품/해제 (return / backorder_release) 제외 — 원영수증 상속이라 변경 위험.
-- 일반 derived: vat_in_payment = (vat_amount > 0) 으로 정정.
-- 부수 영향: day_total / prev_balance / post_balance 도 다시 계산해야 정합.
--   day_total = vat_in_payment ? (supply+vat) : supply
--   prev_balance / post_balance 는 customers.outstanding_vat 현재값에 의존 — 시간 지나면 정합 X.
--   → 정공법: receipt_vat_in_payment 만 정정. day_total 은 receipt_supply_amount + receipt_vat_amount 로
--     재계산 (잔액 박스 prev/post 는 그대로 — 박제 immutable 원칙).

UPDATE orders
SET receipt_vat_in_payment = (COALESCE(vat_amount, 0) > 0),
    receipt_day_total      = COALESCE(receipt_supply_amount, 0) + COALESCE(receipt_vat_amount, 0)
WHERE receipt_no IS NOT NULL
  AND COALESCE(order_source, '') NOT IN ('return', 'backorder_release')
  AND receipt_vat_in_payment IS DISTINCT FROM (COALESCE(vat_amount, 0) > 0);

NOTIFY pgrst, 'reload schema';

COMMIT;
