-- ============================================================
-- 180: tenants → linked customers 마스터 정보 sync (retail-first 정공법, 179 대체)
--
-- 작성: 2026-05-15
-- 사장 정책 (2026-05-15 확정):
--   "거래처 정보는 retail 이 source of truth. wholesale 은 자기 영역 (외상한도/메모/연락처 분류 등) 만 관리.
--    retail 가입 시 입력한 정보 (사업자번호/매장명/주소/대표연락처/결제수단) 는 자동으로 wholesale 측 customers 에 sync."
--
-- 컬럼 카테고리
--   A) retail 마스터 (retail source of truth, customers 자동 sync):
--        company_name, owner_name, phone, address, business_number, default_payment_method
--      include_vat 은 default_payment_method 종속 → 같이 sync
--   B) wholesale 전용 (wholesale 사장이 관리, retail 모름):
--        business_name, tax_email, contact1_*, contact2_*, region, business_form,
--        credit_limit, memo, buyer_*, outstanding_balance, outstanding_vat
--
-- 179 대체 이유
--   179 는 default_payment_method 만 sync. 사장 정책상 retail 마스터 전체 sync 필요.
--   미래 retail 가입 폼 확장 시 (예: tax_email 받기 시작) tenants ALTER + 본 trigger 의 watch 컬럼 추가만으로 자동 sync.
--
-- 영향 검증
--   - 178 trigger (customers BEFORE UPDATE — default_payment_method 변경 시 include_vat sync):
--     본 trigger 가 default_payment_method 변경 시 include_vat 도 함께 명시 UPDATE
--     → 178 조건 (NEW.include_vat IS NOT DISTINCT FROM OLD) 미충족 → 안 발동 → chain 안전
--   - 마스터 외 컬럼만 변경 시 (예: tenants.is_active): trigger watch 컬럼 아님 → 안 발동
--   - wholesale tenant 의 마스터 변경: linked_tenant_id 로 참조하는 customers 없음 → 영향 0
--
-- 멱등 + BEGIN/COMMIT
-- ============================================================

BEGIN;

-- ─────────────────────────────────────────────────────────
-- 179 trigger / 함수 DROP (대체)
-- ─────────────────────────────────────────────────────────
DROP TRIGGER IF EXISTS tenants_sync_linked_customers_payment_method ON tenants;
DROP FUNCTION IF EXISTS tenants_sync_linked_customers_payment_method();


-- ─────────────────────────────────────────────────────────
-- 신규: 마스터 정보 일반 sync 함수
-- ─────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION tenants_sync_linked_customers()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  v_dpm_changed BOOLEAN;
BEGIN
  v_dpm_changed := NEW.default_payment_method IS DISTINCT FROM OLD.default_payment_method;

  IF v_dpm_changed
     OR NEW.company_name     IS DISTINCT FROM OLD.company_name
     OR NEW.owner_name       IS DISTINCT FROM OLD.owner_name
     OR NEW.phone            IS DISTINCT FROM OLD.phone
     OR NEW.address          IS DISTINCT FROM OLD.address
     OR NEW.business_number  IS DISTINCT FROM OLD.business_number THEN

    UPDATE customers
    SET
      company_name           = NEW.company_name,
      owner_name             = NEW.owner_name,
      phone                  = NEW.phone,
      address                = NEW.address,
      business_number        = NEW.business_number,
      default_payment_method = NEW.default_payment_method,
      -- include_vat 은 default_payment_method 변경 시만 sync.
      -- 그 외 컬럼만 변경된 경우 wholesale 측 토글 의도 보호 (옛값 유지)
      include_vat = CASE
        WHEN v_dpm_changed THEN (NEW.default_payment_method = 'credit')
        ELSE customers.include_vat
      END
    WHERE linked_tenant_id = NEW.id;

  END IF;

  RETURN NEW;
END;
$$;

-- 미래 컬럼 추가 시: tenants ALTER + customers ALTER + 본 함수의 IF/UPDATE 에 컬럼 한 줄 추가 + 아래 trigger 의 OF 절에 컬럼 한 줄 추가.
DROP TRIGGER IF EXISTS tenants_sync_linked_customers ON tenants;
CREATE TRIGGER tenants_sync_linked_customers
  AFTER UPDATE OF
    default_payment_method, company_name, owner_name, phone, address, business_number
  ON tenants
  FOR EACH ROW EXECUTE FUNCTION tenants_sync_linked_customers();


-- ─────────────────────────────────────────────────────────
-- 완료 메시지
-- ─────────────────────────────────────────────────────────
DO $$
BEGIN
  RAISE NOTICE '[180] tenants → linked customers 마스터 정보 sync 일반화 정착. retail-first 정공법.';
END $$;

COMMIT;
