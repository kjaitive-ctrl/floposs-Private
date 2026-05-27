-- ============================================================
-- 102: 영수증 v2 Phase 1 — 박제 컬럼 + 보안 1단계 (감사 trigger)
--
-- 설계 (회의 2026-05-03):
--   영수증 = 주문 1:1. 발행 시점의 잔액 4숫자 박제.
--   미송/보류 출고 시 신규 주문 자동 생성 (Phase 2 이후) — 그 신규 주문이
--   원본 주문에서 파생됨을 derived_from_order_id 로 표시.
--   refresh_order_revenue 가 derived 주문에는 외상 변동 X (Phase 3 에서 처리).
--
-- 본 마이그는 컬럼/trigger 추가만. 기존 동작 영향 0.
-- ============================================================

-- ── orders: 영수증 박제 컬럼 (모두 NULLable, 기존 행 영향 0) ────────────
ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS receipt_no              TEXT,
  ADD COLUMN IF NOT EXISTS receipt_issued_at       TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS receipt_prev_balance    NUMERIC(12,2),
  ADD COLUMN IF NOT EXISTS receipt_day_total       NUMERIC(12,2),
  ADD COLUMN IF NOT EXISTS receipt_payment_method  TEXT
    CHECK (receipt_payment_method IS NULL OR receipt_payment_method IN ('cash','transfer','credit')),
  ADD COLUMN IF NOT EXISTS receipt_payment_amount  NUMERIC(12,2),
  ADD COLUMN IF NOT EXISTS receipt_post_balance    NUMERIC(12,2),
  ADD COLUMN IF NOT EXISTS receipt_print_count     INT DEFAULT 0,
  ADD COLUMN IF NOT EXISTS receipt_last_printed_at TIMESTAMPTZ,
  -- Phase 2 준비: 미송/보류 출고로 파생된 신규 주문 식별.
  -- refresh_order_revenue 가 NOT NULL 이면 외상 변동 X (이중 계산 방지)
  ADD COLUMN IF NOT EXISTS derived_from_order_id   UUID REFERENCES orders(id);

-- 파생 주문 빠른 조회 (원본 주문 → 파생 주문들)
CREATE INDEX IF NOT EXISTS idx_orders_derived_from_order_id
  ON orders(derived_from_order_id) WHERE derived_from_order_id IS NOT NULL;

-- 영수증 번호 빠른 조회 (재출력 시)
CREATE INDEX IF NOT EXISTS idx_orders_receipt_no
  ON orders(tenant_id, receipt_no) WHERE receipt_no IS NOT NULL;

-- ── 보안 1단계: created_by 자동 채움 trigger ──────────────────────────
-- 모든 INSERT 에서 created_by 가 NULL 이면 auth.uid() 자동 채움.
-- SECURITY DEFINER RPC 안에서도 auth.uid() = 호출자 JWT.sub (정상 동작)
-- service_role / cron 호출 시 auth.uid() = NULL → created_by NULL 유지

CREATE OR REPLACE FUNCTION fill_created_by_from_auth()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.created_by IS NULL THEN
    NEW.created_by := auth.uid();
  END IF;
  RETURN NEW;
END;
$$;

-- transactions: 입출금 부정 추적용 (가장 중요)
DROP TRIGGER IF EXISTS trg_fill_created_by ON transactions;
CREATE TRIGGER trg_fill_created_by
  BEFORE INSERT ON transactions
  FOR EACH ROW EXECUTE FUNCTION fill_created_by_from_auth();

-- orders: 주문 생성자 추적
DROP TRIGGER IF EXISTS trg_fill_created_by ON orders;
CREATE TRIGGER trg_fill_created_by
  BEFORE INSERT ON orders
  FOR EACH ROW EXECUTE FUNCTION fill_created_by_from_auth();

-- inbound_orders: 입고 (단가 조작 추적)
DROP TRIGGER IF EXISTS trg_fill_created_by ON inbound_orders;
CREATE TRIGGER trg_fill_created_by
  BEFORE INSERT ON inbound_orders
  FOR EACH ROW EXECUTE FUNCTION fill_created_by_from_auth();
