-- ============================================================
-- 173: sync_balance_from_transactions — customer SUM 에서 credit_apply 제외 (audit only)
--
-- 사장 보고 (2026-05-12):
--   "주문처리 후 매입금이 있는 거래처의 자동결제처리 코드 확인/점검해줘"
--
-- 버그:
--   162 sync 식이 customer outstanding_balance / outstanding_vat 에서도 credit_apply -amount 로
--   처리 → 매입금 자동 충당 시 매입금 잔여가 줄지 않거나 복원됨.
--
--   시뮬 (매입금 100 보유, 새 거래 60):
--     직전 outstanding_balance = -100
--     shipment +60 박제 → sync: -100 + 60 = -40
--     credit_apply +60 박제 (매입금 자동 충당) → sync: -100 + 60 - 60 = -100
--     → 매입금 잔여가 100 으로 복원됨 (정답: -40, 매입금 40 잔존)
--
-- 사장 단일 ledger 모델 (메모리 회계 정합성 절대원칙):
--   당잔 = 전잔 + 당일 − 받은돈
--   credit + 매입금 보유: -100 + 30 - 0 = -70 (매입금 70 잔존)
--   → 매입금 자동 충당은 받은돈에 포함 X (audit only). customer balance 영향 X 이어야 정합.
--
-- Fix:
--   customer outstanding_balance / outstanding_vat SUM 에서 credit_apply 제거 (audit only).
--   orders outstanding_amount SUM 은 그대로 유지 (order 결제 마킹 정합용 — 자동 충당 시 -=).
--
-- 영향:
--   - 신규 처리: 매입금 보유 거래처 매출 발생 시 balance 가 자연스럽게 줄어듦
--   - 기존 박제: customers backfill 1회 재계산
--   - orders 영향 X (sync 식 그대로)
--
-- 134 분석 정정:
--   134 의 "trigger -amount 가 진실" 분석은 사장 모델 (받은돈 0) 와 어긋남.
--   credit_apply 는 audit only. paid 마킹 + audit 박제는 1쌍 원칙 유지.
-- ============================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.sync_balance_from_transactions()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_tx_row    RECORD;
  v_order_id  UUID;
  v_customer_id UUID;
BEGIN
  v_tx_row := COALESCE(NEW, OLD);
  v_order_id := v_tx_row.order_id;
  v_customer_id := v_tx_row.customer_id;

  -- orders.outstanding_amount: credit_apply -amount 유지 (order 결제 마킹 정합)
  IF v_order_id IS NOT NULL THEN
    UPDATE orders
    SET outstanding_amount = (
      SELECT COALESCE(SUM(CASE
        WHEN source IN ('shipment', 'refund') THEN amount
        WHEN source IN ('return', 'payment', 'credit_apply', 'purchase', 'vat_collection') THEN -amount
        ELSE 0
      END), 0)
      FROM transactions WHERE order_id = v_order_id AND vat_type = 'supply'
    )
    WHERE id = v_order_id;
  END IF;

  -- customers: credit_apply 제외 (audit only, 사장 단일 ledger 정합)
  IF v_customer_id IS NOT NULL THEN
    UPDATE customers
    SET outstanding_balance = (
        SELECT COALESCE(SUM(CASE
          WHEN source IN ('shipment', 'refund') THEN amount
          WHEN source IN ('return', 'payment', 'purchase') THEN -amount
          ELSE 0
        END), 0)
        FROM transactions WHERE customer_id = v_customer_id AND vat_type = 'supply'
      ),
      outstanding_vat = (
        SELECT COALESCE(SUM(CASE
          WHEN source IN ('shipment', 'refund') THEN amount
          WHEN source IN ('return', 'payment', 'vat_collection') THEN -amount
          ELSE 0
        END), 0)
        FROM transactions WHERE customer_id = v_customer_id AND vat_type = 'vat'
      )
    WHERE id = v_customer_id;
  END IF;

  RETURN COALESCE(NEW, OLD);
END;
$$;


-- ── Backfill: 운영 데이터 일괄 재계산 (credit_apply 제외 식 적용) ──
UPDATE customers c
SET outstanding_balance = (
      SELECT COALESCE(SUM(CASE
        WHEN source IN ('shipment', 'refund') THEN amount
        WHEN source IN ('return', 'payment', 'purchase') THEN -amount
        ELSE 0
      END), 0)
      FROM transactions WHERE customer_id = c.id AND vat_type = 'supply'
    ),
    outstanding_vat = (
      SELECT COALESCE(SUM(CASE
        WHEN source IN ('shipment', 'refund') THEN amount
        WHEN source IN ('return', 'payment', 'vat_collection') THEN -amount
        ELSE 0
      END), 0)
      FROM transactions WHERE customer_id = c.id AND vat_type = 'vat'
    );

COMMIT;

NOTIFY pgrst, 'reload schema';
