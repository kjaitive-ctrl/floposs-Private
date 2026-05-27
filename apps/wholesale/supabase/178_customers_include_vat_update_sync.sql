-- ============================================================
-- 178: customers.include_vat UPDATE 자동 sync (마이그 177 안전망 확장)
--
-- 작성: 2026-05-15
-- 배경
--   - 마이그 177: BEFORE INSERT 에 include_vat NULL 이면 default_payment_method 따라 자동 채움
--   - 그러나 UPDATE 는 무방비 — 사장이 default_payment_method 만 변경하고 include_vat 안 바꾸면 정합 깨짐
--   - CustomerModal payload (line 78) 는 둘 다 동시 박제하지만, 미래 다른 path
--     (직접 SQL / 신규 API / 자동 등록 UPDATE) 에서 누락 가능
--
-- 본 마이그
--   BEFORE UPDATE trigger 신설 — 다음 조건 모두 충족 시 include_vat 자동 sync:
--     1. NEW.default_payment_method IS DISTINCT FROM OLD (결제수단 변경됨)
--     2. NEW.include_vat IS NOT DISTINCT FROM OLD (사장이 include_vat 안 건드림)
--   둘 다 변경한 경우 → 사장 의도 존중 (trigger 안 발동)
--   include_vat 만 변경한 경우 → 사장 의도적 토글 존중 (trigger 안 발동)
--   default_payment_method 만 변경한 경우 → trigger 가 자동 sync
--
-- 영향 검토 (기존 wholesale 기능)
--   - CustomerModal: 매 저장 시 둘 다 명시 박제 (include_vat = dpm==='credit') → trigger 조건 미충족 → 영향 0
--   - SaleForm 거래처 신규 등록: CustomerModal 호출 → 동일
--   - 마이그 171 backfill 결과: 모든 기존 row 가 (dpm, include_vat) 정합 → UPDATE 시 trigger 영향 0
--   - 외상/매출 박제 RPC (process_register_action / refresh_order_revenue / issue_receipt_snapshot):
--     customers row 직접 UPDATE 안 함 (orders/transactions 만 INSERT) → 영향 0
--
-- 안전 — 멱등, BEGIN/COMMIT
-- ============================================================

BEGIN;

CREATE OR REPLACE FUNCTION customers_sync_include_vat_on_payment_change()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  -- 사장이 default_payment_method 만 변경하고 include_vat 안 건드린 경우 → 자동 sync
  IF NEW.default_payment_method IS DISTINCT FROM OLD.default_payment_method
     AND NEW.include_vat IS NOT DISTINCT FROM OLD.include_vat THEN
    NEW.include_vat := (NEW.default_payment_method = 'credit');
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS customers_sync_include_vat_on_payment_change ON customers;
CREATE TRIGGER customers_sync_include_vat_on_payment_change
  BEFORE UPDATE ON customers
  FOR EACH ROW EXECUTE FUNCTION customers_sync_include_vat_on_payment_change();


-- ─────────────────────────────────────────────────────────
-- 완료 메시지
-- ─────────────────────────────────────────────────────────
DO $$
BEGIN
  RAISE NOTICE '[178] customers UPDATE 시 default_payment_method 변경 → include_vat 자동 sync (사장 토글 의도 존중) 정착.';
END $$;

COMMIT;
