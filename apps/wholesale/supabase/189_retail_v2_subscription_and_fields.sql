-- ============================================================
-- 189: retail v2 — 내정보 확장 + 구독 vertical 분리 + 레거시 폐기
--
-- 작성: 2026-05-26
-- 결정: 사장 회의 2026-05-26 (retail 본격 운영 시작, 가드 박제 결정)
--
-- 본 마이그
--   ① tenants 신규 6 컬럼 (retail 내정보 확장)
--      - tax_invoice_email / contact_email / warehouse_address
--      - warehouse_same_as_office / warehouse_phone / store_url
--   ② subscription_plans.vertical (wholesale/retail 플랜 풀 분리)
--   ③ tenants.subscription_plan / subscription_status 레거시 폐기
--   ④ Free Beta 플랜 INSERT (retail vertical, price 0)
--   ⑤ 기존 retail tenant backfill (Free Beta + expires_at = now()+3개월)
--
-- 영향
--   - wholesale: subscription_plans.vertical DEFAULT 'wholesale' → 기존 플랜 그대로
--   - wholesale 가입: lib/tenant.ts 의 subscription_plan/status INSERT 줄 제거 동반 commit
--   - retail: 기존 1명(test 매장) Free Beta 자동 박제 → 가드 박혀도 즉시 차단 X
--
-- 후속 작업 (별도 commit)
--   - lib/tenant.ts: subscription_plan/status INSERT 줄 제거 (동반)
--   - retail-site /api/order-portal/signup: 신규 필드 박제 + 베타 플랜 자동 박제
--   - retail-site /signup 폼 갱신 (라벨 변경 + 신규 입력칸)
--   - retail-site /dashboard/settings 신설 (내정보 + 구독)
--   - admin/plans vertical 탭
--   - admin/accounts retail 탭 plan selectbox
--   - retail-site layout 가드 + /subscription-required 신설
-- ============================================================


-- ─────────────────────────────────────────────────────────
-- ① tenants 신규 6 컬럼
-- ─────────────────────────────────────────────────────────
ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS tax_invoice_email        TEXT,
  ADD COLUMN IF NOT EXISTS contact_email            TEXT,
  ADD COLUMN IF NOT EXISTS warehouse_address        TEXT,
  ADD COLUMN IF NOT EXISTS warehouse_same_as_office BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS warehouse_phone          TEXT,
  ADD COLUMN IF NOT EXISTS store_url                TEXT;

COMMENT ON COLUMN tenants.tax_invoice_email IS
  '세금계산서 발행용 이메일. retail 가입 시 박제. wholesale 사용 가능.';
COMMENT ON COLUMN tenants.contact_email IS
  '담당자 연락용 이메일 (dummy auth email 과 별개).';
COMMENT ON COLUMN tenants.warehouse_address IS
  '물류/매장 주소. warehouse_same_as_office=true 면 address 와 동일 (UI 단계 처리).';
COMMENT ON COLUMN tenants.warehouse_same_as_office IS
  '물류/매장 주소가 사무실 주소(address)와 동일한지. 기본 true.';
COMMENT ON COLUMN tenants.warehouse_phone IS
  '물류/매장 연락처.';
COMMENT ON COLUMN tenants.store_url IS
  '온라인 쇼핑몰 URL (스마트스토어/카페24/자체몰 등).';


-- ─────────────────────────────────────────────────────────
-- ② subscription_plans.vertical — 플랜 풀을 vertical 별로 분리
-- ─────────────────────────────────────────────────────────
ALTER TABLE subscription_plans
  ADD COLUMN IF NOT EXISTS vertical TEXT NOT NULL DEFAULT 'wholesale';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'subscription_plans_vertical_check'
  ) THEN
    ALTER TABLE subscription_plans
      ADD CONSTRAINT subscription_plans_vertical_check
      CHECK (vertical IN (
        'wholesale','retail','logistics','designer','platform','restaurant','other'
      ));
  END IF;
END $$;

COMMENT ON COLUMN subscription_plans.vertical IS
  '플랜 적용 vertical. tenants.tenant_type 과 매칭. admin/plans 탭 분리, admin/accounts selectbox 필터에 사용.';

CREATE INDEX IF NOT EXISTS idx_subscription_plans_vertical_active
  ON subscription_plans(vertical, is_active);


-- ─────────────────────────────────────────────────────────
-- ④ Free Beta 플랜 INSERT (retail vertical) — 멱등
-- ─────────────────────────────────────────────────────────
INSERT INTO subscription_plans (name, description, price, billing_cycle, features, is_active, sort_order, vertical)
SELECT
  'Free Beta',
  '3개월 무료 베타. 정식 출시 시 별도 안내.',
  0,
  'monthly',
  '["전 기능 이용 가능", "3개월 무료", "정식 출시 시 별도 안내"]'::jsonb,
  true,
  0,
  'retail'
WHERE NOT EXISTS (
  SELECT 1 FROM subscription_plans
  WHERE name = 'Free Beta' AND vertical = 'retail'
);


-- ─────────────────────────────────────────────────────────
-- ⑤ 기존 retail tenant backfill — Free Beta + 3개월
-- ─────────────────────────────────────────────────────────
-- 정책 (i): 마이그 적용 시점 + 3개월 (가입일 무관 일괄). 기존 1명도 안전.
DO $$
DECLARE
  v_beta_id UUID;
  v_count   INT;
BEGIN
  SELECT id INTO v_beta_id
  FROM subscription_plans
  WHERE name = 'Free Beta' AND vertical = 'retail'
  LIMIT 1;

  IF v_beta_id IS NULL THEN
    RAISE EXCEPTION '[189] Free Beta 플랜이 INSERT 되지 않음. ④ 실행 결과 확인 필요.';
  END IF;

  UPDATE tenants
     SET plan_id                 = v_beta_id,
         subscription_expires_at = now() + INTERVAL '3 months'
   WHERE tenant_type = 'retail'
     AND plan_id IS NULL;

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RAISE NOTICE '[189] retail tenant backfill 완료: % 명', v_count;
END $$;


-- ─────────────────────────────────────────────────────────
-- ③ 레거시 컬럼 DROP — subscription_plan / subscription_status
-- ─────────────────────────────────────────────────────────
-- 사용처: wholesale lib/tenant.ts INSERT 1줄 외 read 0건 (2026-05-26 확인).
-- 본 마이그 적용 전 lib/tenant.ts 도 같이 수정 commit 필요 (동반 변경).

ALTER TABLE tenants
  DROP COLUMN IF EXISTS subscription_plan,
  DROP COLUMN IF EXISTS subscription_status;


-- ─────────────────────────────────────────────────────────
-- 완료
-- ─────────────────────────────────────────────────────────
DO $$
BEGIN
  RAISE NOTICE '[189] retail v2 인프라 정착 완료. 후속: 가입 API + /dashboard/settings + 가드.';
END $$;
