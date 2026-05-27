-- ============================================================
-- 179: tenants.default_payment_method UPDATE → 연동된 customers 자동 sync
--
-- 작성: 2026-05-15
-- 사장 정책 (2026-05-15 확정):
--   "결제수단 변경 권한은 retail 측에만. retail user 가 본인 결제수단 변경 시
--    연결된 모든 wholesale customers 가 자동 sync. 단 박제 불변 원칙 —
--    옛 transactions/orders/영수증/외상은 절대 갱신 X. 새 거래부터 새 정책."
--
-- 본 마이그
--   tenants AFTER UPDATE OF default_payment_method trigger 신설:
--     1. NEW.default_payment_method IS DISTINCT FROM OLD 일 때만 발동
--     2. customers WHERE linked_tenant_id = NEW.id 일괄 UPDATE
--        - default_payment_method = NEW.default_payment_method
--        - include_vat = (NEW.default_payment_method = 'credit')
--   주의: 178 trigger (customers_sync_include_vat_on_payment_change) 는
--         NEW.include_vat IS NOT DISTINCT FROM OLD 조건이라
--         우리 명시 변경 시점엔 안 발동 (chain 무한 루프 방지 정합).
--
-- 효과
--   - retail user UI → PATCH /api/order-portal/me → tenants UPDATE → 자동 sync
--   - super_admin 이 admin/accounts 에서 tenants 변경해도 자동 sync (안전망)
--   - 직접 SQL UPDATE 도 자동 sync
--   - 박제 데이터 (orders/transactions/영수증) 절대 안 건드림 — customers 마스터만 sync
--
-- 안전 — 영향 검증
--   - wholesale tenant (tenant_type='wholesale') 의 default_payment_method 변경:
--     wholesale tenants 는 default_payment_method NULL 또는 미사용 (메모리 [VAT 절대원칙]).
--     설령 변경되더라도 그 wholesale 의 id 를 linked_tenant_id 로 참조하는 customers 없음
--     (linked_tenant_id 는 retail tenant 의 id 만 가리킴 — schema.sql:194 의 의도)
--     → 영향 0
--   - retail tenant 의 default_payment_method 변경: 의도된 동작. customers sync.
--   - 인덱스 `idx_customers_linked_tenant` (마이그 175) 활용 → O(log n)
--   - cascade chain: tenants UPDATE → customers UPDATE → 178 trigger 발동 검사
--     → NEW.include_vat = (credit?true:false), OLD.include_vat = (옛 dpm credit?true:false)
--     → 우리가 둘 다 명시 변경했으므로 NEW.include_vat IS DISTINCT FROM OLD
--     → 178 trigger 조건 미충족 → 안 발동 (정합)
--
-- 멱등 (DROP TRIGGER IF EXISTS / CREATE OR REPLACE), BEGIN/COMMIT
-- ============================================================

BEGIN;

CREATE OR REPLACE FUNCTION tenants_sync_linked_customers_payment_method()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.default_payment_method IS DISTINCT FROM OLD.default_payment_method THEN
    UPDATE customers
    SET default_payment_method = NEW.default_payment_method,
        include_vat = (NEW.default_payment_method = 'credit')
    WHERE linked_tenant_id = NEW.id;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tenants_sync_linked_customers_payment_method ON tenants;
CREATE TRIGGER tenants_sync_linked_customers_payment_method
  AFTER UPDATE OF default_payment_method ON tenants
  FOR EACH ROW EXECUTE FUNCTION tenants_sync_linked_customers_payment_method();


-- ─────────────────────────────────────────────────────────
-- 완료 메시지
-- ─────────────────────────────────────────────────────────
DO $$
BEGIN
  RAISE NOTICE '[179] tenants.default_payment_method UPDATE → linked customers 자동 sync trigger 정착. retail user 결제수단 변경 흐름 완성.';
END $$;

COMMIT;
