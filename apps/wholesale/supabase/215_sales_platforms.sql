-- ============================================================
-- 215: sales_platforms — 판매채널별 수수료/통화 (지그재그, 식스티퍼센트 등)
--
-- 작성: 2026-07-09
-- 배경: /products 가격 토글에서 채널별로 (수수료 역산 + 통화환산) 가격을
--   보여주기 위한 tenant 커스텀 채널 목록. models 테이블(196)과 동일 패턴
--   (tenant_id FK + 평범 스칼라 컬럼 + RLS 비활성).
--
-- 계산 공식 (사장 결정, 2026-07-09):
--   표시가 = 기준가 / (1 - fee_rate/100)   -- 역산, 마진 보존
--   통화 KRW 아니면 위 결과를 tenants.fx_rate_usd/jpy 로 나눔.
--   VAT 구분 없음 — 지금 입력된 판매가 그대로에 수수료율 적용.
-- ============================================================

BEGIN;

CREATE TABLE IF NOT EXISTS sales_platforms (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  fee_rate   NUMERIC(5,2) NOT NULL DEFAULT 0,   -- % 단위, e.g. 9.5
  currency   TEXT NOT NULL DEFAULT 'KRW' CHECK (currency IN ('KRW','JPY','USD')),
  sort_order INT NOT NULL DEFAULT 0,
  is_active  BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);
ALTER TABLE sales_platforms DISABLE ROW LEVEL SECURITY;

ALTER TABLE tenants ADD COLUMN IF NOT EXISTS fx_rate_usd NUMERIC(10,4);  -- 1 USD = ? KRW (사용자 수동 설정)
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS fx_rate_jpy NUMERIC(10,4);  -- 1 JPY = ? KRW (사용자 수동 설정)

COMMENT ON TABLE sales_platforms IS
  '테넌트별 판매채널(지그재그, 식스티퍼센트 등). /products 가격 토글에서 수수료 역산 + 통화환산에 사용.';
COMMENT ON COLUMN tenants.fx_rate_usd IS '1 USD = ? KRW. 사용자가 설정에서 수동 입력 (실시간 자동갱신 아님).';
COMMENT ON COLUMN tenants.fx_rate_jpy IS '1 JPY = ? KRW. 사용자가 설정에서 수동 입력 (실시간 자동갱신 아님).';

COMMIT;
