-- ============================================================
-- 175: retail v1 (외부 주문 포털) 인프라 정착
--
-- 작성: 2026-05-14
-- 결정 합의: 외부 주문 포털 메모리 + 멀티업종 SaaS 메모리 (2026-05-12 ~ 14)
--
-- 배경
--   C-1 결정: retail vertical 도 단일 tenants/users 모델 (멀티업종 SaaS).
--   retail-site = retail vertical 의 self-contained dashboard.
--   외부 주문 포털 = retail-site v1 (주문 기능만 켠 상태).
--
-- 본 마이그
--   ① tenants 보강 (retail 가입 시 매장 정보 박제용 컬럼)
--   ② tenants.tenant_type CHECK 확장 — 5축 가치사슬 (디자이너/도매/물류/소매/플랫폼) + restaurant + other
--   ③ customers 보강 (외부 주문 자동 등록 출처 식별)
--   ④ 인덱스 추가 (admin 3탭, [외] 뱃지, dedupe)
--   ⑤ retail_001~004b 의 별 retail_* 테이블 10개 폐기 (C-1 단일 모델 정착)
--   ⑥ users.retailer_id 폐기 (단일 tenant_id 통합)
--
-- 적용 후 후속 작업 (별도 commit)
--   - /api/auth/retail-signup/route.ts 갱신: retail_retailers INSERT → tenants(tenant_type='retail') INSERT
--   - admin/accounts 3탭 (wholesale/retail/+@ tenant_type 필터)
--   - retail-site /order/* + /api/order-portal/* 신설 (v1 본 작업)
--   - schema.sql 갱신 (단일 소스 동기화)
--
-- 안전
--   - 사장 합의 (2026-05-14): retail 가입자 = 0
--   - 모든 ALTER 멱등 (IF NOT EXISTS / IF EXISTS)
--   - DROP 전 row count 출력. retail_users / users.retailer_id NOT NULL 발견 시 EXCEPTION 중단
--   - retail_retailers / retail_models 등 개발 더미 데이터는 NOTICE 만 출력 후 DROP CASCADE
--
-- 영향 없음 (변경 0)
--   - wholesale 데이터/기능 전체
--   - 영업 세션 / 영수증 / 처리 정공법 (process_register_action 등) 모두 무관
--   - schema.sql 의 tenant_connections / product_mappings / customers.linked_tenant_id — 이미 C-1 정합
-- ============================================================


-- ─────────────────────────────────────────────────────────
-- ① tenants 보강 (retail 매장 정보 박제 컬럼)
-- ─────────────────────────────────────────────────────────
-- 신설 컬럼만 (기존 phone, address, owner_name 활용)
ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS default_payment_method TEXT,
  ADD COLUMN IF NOT EXISTS last_order_at          TIMESTAMPTZ;

-- default_payment_method CHECK (retail 가입 시 박제, 변경 X)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'tenants_default_payment_method_check'
  ) THEN
    ALTER TABLE tenants
      ADD CONSTRAINT tenants_default_payment_method_check
      CHECK (default_payment_method IS NULL
          OR default_payment_method IN ('cash','transfer','credit'));
  END IF;
END $$;

COMMENT ON COLUMN tenants.default_payment_method IS
  'retail tenant 기본 결제수단. 가입 시 박제 후 변경 X. wholesale tenant 는 NULL.';
COMMENT ON COLUMN tenants.last_order_at IS
  'retail tenant 마지막 주문 전송 시각 (외부 주문 포털 submit 시 갱신).';


-- ─────────────────────────────────────────────────────────
-- ② tenants.tenant_type CHECK 확장 — 5축 가치사슬
-- ─────────────────────────────────────────────────────────
-- 현재: ('wholesale','retail','logistics') 3개
-- 변경: ('wholesale','retail','logistics','designer','platform','restaurant','other') 7개
-- 5축 = 디자이너/도매/물류/소매/플랫폼. restaurant/other 는 5축 외 +@ 분류.
-- 새 vertical 추가 시 본 CHECK 도 ALTER (account_types 와 함께).

DO $$
BEGIN
  -- 기존 CHECK 제약 제거
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'tenants_tenant_type_check'
  ) THEN
    ALTER TABLE tenants DROP CONSTRAINT tenants_tenant_type_check;
  END IF;

  -- 새 CHECK 추가
  ALTER TABLE tenants
    ADD CONSTRAINT tenants_tenant_type_check
    CHECK (tenant_type IN (
      'wholesale','retail','logistics','designer','platform','restaurant','other'
    ));
END $$;

COMMENT ON COLUMN tenants.tenant_type IS
  '5축 가치사슬 vertical 식별. account_types.code 와 매칭. 새 vertical 추가 시 본 CHECK + account_types 시드 동시 갱신.';


-- ─────────────────────────────────────────────────────────
-- ③ customers 보강 (외부 주문 출처 식별)
-- ─────────────────────────────────────────────────────────
ALTER TABLE customers
  ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'manual';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'customers_source_check'
  ) THEN
    ALTER TABLE customers
      ADD CONSTRAINT customers_source_check
      CHECK (source IN ('manual','external_order'));
  END IF;
END $$;

COMMENT ON COLUMN customers.source IS
  'manual = 사장 직접 등록. external_order = 외부 주문 포털(retail v1) 자동 등록. linked_tenant_id 와 함께 사용.';


-- ─────────────────────────────────────────────────────────
-- ④ 인덱스 (admin 3탭, [외] 뱃지, dedupe 쿼리 성능)
-- ─────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_tenants_tenant_type
  ON tenants(tenant_type);

CREATE INDEX IF NOT EXISTS idx_customers_linked_tenant
  ON customers(linked_tenant_id)
  WHERE linked_tenant_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_customers_source
  ON customers(source)
  WHERE source <> 'manual';

CREATE INDEX IF NOT EXISTS idx_orders_order_source_external
  ON orders(order_source)
  WHERE order_source IS DISTINCT FROM 'internal';


-- ─────────────────────────────────────────────────────────
-- ⑤ retail_001 ~ retail_004b 별 테이블 10개 폐기
-- ─────────────────────────────────────────────────────────
-- 폐기 대상 (FK 의존 역순)
--   retail_shoot_items, retail_shoots, retail_models
--   retail_platform_listings, retail_platforms
--   retail_inventory, retail_product_variants, retail_products
--   retail_users, retail_retailers
--
-- 사장 합의: 실제 retail 가입자 0. 개발 더미는 폐기 OK.
-- 검증: retail_users 에 데이터 있으면 중단. 그 외는 NOTICE 만 출력.

DO $$
DECLARE
  v_count INT;
BEGIN
  -- retail_users 엄격 검증 (실사용자 보호)
  IF EXISTS (SELECT 1 FROM information_schema.tables
             WHERE table_schema='public' AND table_name='retail_users') THEN
    EXECUTE 'SELECT COUNT(*) FROM retail_users' INTO v_count;
    RAISE NOTICE '[175] retail_users row count: %', v_count;
    IF v_count > 0 THEN
      RAISE EXCEPTION
        '[175 중단] retail_users 에 % rows 가 있습니다. 사장 합의(데이터 0)와 충돌. 데이터 검증 후 재실행 바랍니다.',
        v_count;
    END IF;
  END IF;

  -- retail_retailers NOTICE (개발 더미 가능)
  IF EXISTS (SELECT 1 FROM information_schema.tables
             WHERE table_schema='public' AND table_name='retail_retailers') THEN
    EXECUTE 'SELECT COUNT(*) FROM retail_retailers' INTO v_count;
    RAISE NOTICE '[175] retail_retailers row count (개발 더미 포함): %', v_count;
  END IF;

  -- 그 외 retail_* NOTICE
  IF EXISTS (SELECT 1 FROM information_schema.tables
             WHERE table_schema='public' AND table_name='retail_products') THEN
    EXECUTE 'SELECT COUNT(*) FROM retail_products' INTO v_count;
    RAISE NOTICE '[175] retail_products row count: %', v_count;
  END IF;
END $$;

-- FK 의존 역순으로 DROP (CASCADE 안전망)
DROP TABLE IF EXISTS retail_shoot_items        CASCADE;
DROP TABLE IF EXISTS retail_shoots             CASCADE;
DROP TABLE IF EXISTS retail_models             CASCADE;
DROP TABLE IF EXISTS retail_platform_listings  CASCADE;
DROP TABLE IF EXISTS retail_platforms          CASCADE;
DROP TABLE IF EXISTS retail_inventory          CASCADE;
DROP TABLE IF EXISTS retail_product_variants   CASCADE;
DROP TABLE IF EXISTS retail_products           CASCADE;
DROP TABLE IF EXISTS retail_users              CASCADE;
DROP TABLE IF EXISTS retail_retailers          CASCADE;


-- ─────────────────────────────────────────────────────────
-- ⑥ users.retailer_id 폐기 (단일 tenant_id 통합)
-- ─────────────────────────────────────────────────────────
-- 마이그 078 에서 추가됨. C-1 결정으로 폐기.
-- retail user 는 users.tenant_id 만 사용 (해당 tenant 의 tenant_type='retail').

DO $$
DECLARE
  v_count INT;
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_schema='public' AND table_name='users' AND column_name='retailer_id') THEN
    EXECUTE 'SELECT COUNT(*) FROM users WHERE retailer_id IS NOT NULL' INTO v_count;
    RAISE NOTICE '[175] users.retailer_id NOT NULL row count: %', v_count;
    IF v_count > 0 THEN
      RAISE EXCEPTION
        '[175 중단] users.retailer_id 에 % rows 가 있습니다. 데이터 이전 (tenant_id 박제) 필요.',
        v_count;
    END IF;
    ALTER TABLE users DROP COLUMN retailer_id;
    RAISE NOTICE '[175] users.retailer_id 컬럼 폐기 완료';
  END IF;
END $$;


-- ─────────────────────────────────────────────────────────
-- 완료 메시지
-- ─────────────────────────────────────────────────────────
DO $$
BEGIN
  RAISE NOTICE '[175] 외부 주문 포털 v1 인프라 정착 완료. 후속: retail-signup API 갱신 + retail-site /order/* 작업.';
END $$;
