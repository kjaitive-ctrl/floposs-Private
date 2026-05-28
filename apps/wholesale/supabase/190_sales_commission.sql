-- ============================================================
-- 190: 영업 수수료 정산 (영업네트워크 → retail tenant 매핑 → 월 정산)
--
-- 배경: 영업네트워크가 데려온 retail 고객의 구독 결제액 × 수수료율을
--       매월 영업에게 지급. admin TEST2(/test2) 화면에서 관리.
--
-- 정책:
--   - 수수료율 3단 해석: referral.rate_override → agent.default_rate
--                        → platform_settings.default_commission_rate (공통율)
--     rate 단위 = 퍼센트 (10.00 = 10%).
--   - 결제액 기준 = 부가세 포함가. 공급가 = 결제액 / 1.1 → 공급가 × 율 = 수수료.
--   - 결제액 출처: subscription_payments 우선 → 없으면 활성 플랜가 fallback.
--   - 월 정산 '확정' 시 commission_settlement_items 에 rate·금액 박제 (불변).
--   - RLS 비활성 (개발 단계, 다른 테이블과 동일).
-- ============================================================

-- ── 공통 수수료율 (싱글톤 platform_settings 에 컬럼 추가) ──
ALTER TABLE platform_settings
  ADD COLUMN IF NOT EXISTS default_commission_rate NUMERIC(5,2) NOT NULL DEFAULT 0;

COMMENT ON COLUMN platform_settings.default_commission_rate IS
  '영업 공통 기본 수수료율 (%). agent/referral 개별율이 없을 때 적용.';


-- ── 영업네트워크 ──────────────────────────────
CREATE TABLE IF NOT EXISTS sales_agents (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code          TEXT UNIQUE,                -- 영업 표식/코드 (KIM, S001 ...). 비우면 UI가 SA-NNNN 자동부여. 사람이 읽는 식별자.
  name          TEXT NOT NULL,              -- 김영업, 최영업 ...
  phone         TEXT,
  memo          TEXT,
  is_active     BOOLEAN NOT NULL DEFAULT true,
  default_rate  NUMERIC(5,2),               -- 개별 기본율 (%). NULL = 공통율 사용.
  issues_tax_invoice BOOLEAN NOT NULL DEFAULT false,  -- 세금계산서: 수수료 지급 시 세금계산서 수취 대상
  is_business_income BOOLEAN NOT NULL DEFAULT false,  -- 사업소득: 3.3% 원천징수 대상
  created_at    TIMESTAMPTZ DEFAULT now(),
  updated_at    TIMESTAMPTZ DEFAULT now()
);

-- 기존 DB 보강 (테이블이 이미 있는 경우 재실행 시 컬럼 추가)
ALTER TABLE sales_agents ADD COLUMN IF NOT EXISTS issues_tax_invoice BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE sales_agents ADD COLUMN IF NOT EXISTS is_business_income BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE sales_agents DISABLE ROW LEVEL SECURITY;


-- ── 고객 매핑 (누가 데려온 retail tenant) ──────
CREATE TABLE IF NOT EXISTS tenant_referrals (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  agent_id       UUID NOT NULL REFERENCES sales_agents(id) ON DELETE CASCADE,
  rate_override  NUMERIC(5,2),              -- 이 매핑만의 특별율 (%). NULL = agent율 → 공통율.
  started_at     DATE NOT NULL DEFAULT (now() AT TIME ZONE 'Asia/Seoul')::date,
  ended_at       DATE,                      -- 이관/종료 (NULL = 진행 중)
  memo           TEXT,
  created_at     TIMESTAMPTZ DEFAULT now()
);

-- tenant 당 진행 중(ended_at IS NULL) 매핑은 1건만.
CREATE UNIQUE INDEX IF NOT EXISTS uq_tenant_referrals_active
  ON tenant_referrals (tenant_id) WHERE ended_at IS NULL;

ALTER TABLE tenant_referrals DISABLE ROW LEVEL SECURITY;


-- ── 구독 결제 원장 (유료화 시 가동, 지금은 빈 채 준비) ──
CREATE TABLE IF NOT EXISTS subscription_payments (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  plan_id     UUID REFERENCES subscription_plans(id),
  amount      NUMERIC(12,2) NOT NULL,       -- 결제액 (부가세 포함)
  period      CHAR(7) NOT NULL,             -- 'YYYY-MM' (정산 귀속 월)
  paid_at     TIMESTAMPTZ DEFAULT now(),
  method      TEXT,
  memo        TEXT,
  created_at  TIMESTAMPTZ DEFAULT now(),
  UNIQUE (tenant_id, period)
);

ALTER TABLE subscription_payments DISABLE ROW LEVEL SECURITY;


-- ── 월 정산 헤더 (확정 시 박제) ────────────────
CREATE TABLE IF NOT EXISTS commission_settlements (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id          UUID NOT NULL REFERENCES sales_agents(id),
  period            CHAR(7) NOT NULL,        -- 'YYYY-MM'
  total_base        NUMERIC(12,2) NOT NULL DEFAULT 0,  -- 공급가 합
  total_commission  NUMERIC(12,2) NOT NULL DEFAULT 0,  -- 수수료 합
  status            TEXT NOT NULL DEFAULT 'confirmed'
                      CHECK (status IN ('confirmed', 'paid')),
  confirmed_at      TIMESTAMPTZ DEFAULT now(),
  paid_at           TIMESTAMPTZ,
  created_at        TIMESTAMPTZ DEFAULT now(),
  UNIQUE (agent_id, period)
);

ALTER TABLE commission_settlements DISABLE ROW LEVEL SECURITY;


-- ── 정산 라인 박제 (영업 → tenant 별) ──────────
CREATE TABLE IF NOT EXISTS commission_settlement_items (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  settlement_id  UUID NOT NULL REFERENCES commission_settlements(id) ON DELETE CASCADE,
  tenant_id      UUID NOT NULL REFERENCES tenants(id),
  company_name   TEXT NOT NULL,             -- 박제 (tenant 이름 변경/삭제 대비)
  plan_name      TEXT,                       -- 박제
  paid_amount    NUMERIC(12,2) NOT NULL,     -- 결제액 (부가세 포함) 박제
  base_amount    NUMERIC(12,2) NOT NULL,     -- 공급가 박제
  rate           NUMERIC(5,2) NOT NULL,      -- 적용 수수료율(%) 박제
  commission     NUMERIC(12,2) NOT NULL,     -- 수수료 박제
  is_estimated   BOOLEAN NOT NULL DEFAULT false  -- true = 플랜가 fallback(예상치)
);

ALTER TABLE commission_settlement_items DISABLE ROW LEVEL SECURITY;


COMMENT ON TABLE sales_agents IS '영업네트워크 — retail 고객을 데려오는 영업. default_rate = 개별 기본 수수료율(%).';
COMMENT ON TABLE tenant_referrals IS '영업 ↔ retail tenant 매핑. tenant 당 진행 중 1건.';
COMMENT ON TABLE subscription_payments IS '구독 결제 원장 (부가세 포함). 유료화 시 가동. 정산 결제액의 1차 출처.';
COMMENT ON TABLE commission_settlements IS '월 영업 수수료 정산 헤더. 확정 시 박제.';
COMMENT ON TABLE commission_settlement_items IS '월 정산 라인 (영업→tenant). 확정 시점 rate·금액 박제 (불변).';
