-- ============================================================
-- 191: AI 크레딧 시스템 (밑작업, 휴면)
--
-- 배경: Claude API 호출에 실제 USD 비용 발생 → tenant 에게 "크레딧"으로 청구.
--   2-layer: Anthropic 토큰(실측) → USD 원가 × 마크업 × 크레딧/USD 환율 = 차감 크레딧.
--   사장님 UI 에는 "크레딧" 만 노출 ([[feedback_naming_convention]]).
--
-- 정책 (사장 결정 2026-05-28):
--   1) 명명: 우리 단위 = "크레딧". Anthropic 토큰과 분리.
--   2) 과금: A 안 — USD 원가 기반. credits_per_usd × markup 으로 환산.
--   3) 무료 쿼터: 일단 X. 추후 구독 플랜에 월 N 크레딧 옵션 추가 가능.
--   4) 지금은 인프라만 — 어떤 메뉴/UI 에도 안 걸음 (admin 측 UI 추후).
--      AI 기능 붙일 때 /api/ai/complete 가 charge_ai_usage RPC 호출하면 자동 정합.
--
-- 박제 정합 원칙 ([[feedback_accounting_integrity]]):
--   - 호출 1건 = ai_usage_logs 1행 + credit_transactions 1행 + tenant_credits UPDATE
--   - 셋 모두 한 RPC 트랜잭션 안에서 처리 → 누락 불가
--   - 마이너스 잔액 불가 (CHECK + RPC 가드)
-- ============================================================

-- ── 1. tenant_credits — 잔액 singleton ──────────────────────
CREATE TABLE IF NOT EXISTS tenant_credits (
  tenant_id   UUID PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  balance     INT NOT NULL DEFAULT 0 CHECK (balance >= 0),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE tenant_credits IS
  'AI 크레딧 잔액 (tenant 당 1행). balance = SUM(credit_transactions.amount).';

ALTER TABLE tenant_credits DISABLE ROW LEVEL SECURITY;

-- ── 2. ai_usage_logs — 호출 박제 (영원히 변경 X) ────────────
CREATE TABLE IF NOT EXISTS ai_usage_logs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  route           TEXT NOT NULL,              -- '/api/ai/complete' 등
  model           TEXT NOT NULL,              -- 'claude-sonnet-4-6' 실제 ID
  input_tokens    INT NOT NULL,
  output_tokens   INT NOT NULL,
  cost_usd        NUMERIC(12, 6) NOT NULL,    -- 실제 Anthropic 원가
  credits_charged INT NOT NULL,               -- 차감 크레딧 (= cost_usd × markup × credits_per_usd)
  user_email      TEXT,                       -- 호출 시점 작성자 (audit)
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ai_usage_logs_tenant_created
  ON ai_usage_logs (tenant_id, created_at DESC);

COMMENT ON TABLE ai_usage_logs IS
  'AI 호출 박제. 1 호출 = 1 row. 절대 UPDATE/DELETE 금지 ([[feedback_accounting_integrity]]).';

ALTER TABLE ai_usage_logs DISABLE ROW LEVEL SECURITY;

-- ── 3. credit_transactions — 잔액 변동 history ──────────────
CREATE TABLE IF NOT EXISTS credit_transactions (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  kind                TEXT NOT NULL
                        CHECK (kind IN ('charge', 'topup', 'refund', 'admin_grant')),
  amount              INT NOT NULL,           -- 음수=차감(charge), 양수=증가(topup/grant/refund)
  balance_after       INT NOT NULL CHECK (balance_after >= 0),
  related_usage_id    UUID REFERENCES ai_usage_logs(id),
  related_payment_id  UUID,                   -- 결제 webhook 시 (v2)
  note                TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_credit_tx_tenant_created
  ON credit_transactions (tenant_id, created_at DESC);

COMMENT ON TABLE credit_transactions IS
  '크레딧 변동 박제. balance = SUM(amount). charge=음수, topup/admin_grant=양수.';

ALTER TABLE credit_transactions DISABLE ROW LEVEL SECURITY;

-- ── 4. platform_settings 확장 — 가격 정책 단일 관리 ──────────
ALTER TABLE platform_settings
  ADD COLUMN IF NOT EXISTS credits_per_usd   INT NOT NULL DEFAULT 1000,
  ADD COLUMN IF NOT EXISTS ai_markup_ratio   NUMERIC(5, 2) NOT NULL DEFAULT 2.00,
  ADD COLUMN IF NOT EXISTS ai_model_pricing  JSONB NOT NULL DEFAULT '{
    "claude-opus-4-7":           {"input": 15.00, "output": 75.00},
    "claude-sonnet-4-6":         {"input":  3.00, "output": 15.00},
    "claude-haiku-4-5-20251001": {"input":  0.80, "output":  4.00}
  }'::jsonb;

COMMENT ON COLUMN platform_settings.credits_per_usd IS
  '1 USD 당 크레딧 수. 사장 설정 가능. 기본 1000 (= 1 크레딧 = $0.001).';
COMMENT ON COLUMN platform_settings.ai_markup_ratio IS
  'Anthropic 원가 대비 청구 마크업. 기본 2.0 (100% 마진).';
COMMENT ON COLUMN platform_settings.ai_model_pricing IS
  '모델별 USD/1M 토큰 단가 (input/output). 가격 인상 시 여기만 수정 ([[feedback_central_source_of_truth]]).';

-- ── 5. RPC: charge_ai_usage ─────────────────────────────────
-- AI 호출 직후 호출. 원가 계산 + 박제 + 차감 모두 atomic.
-- 잔액 부족 시 EXCEPTION → 호출자(route)가 catch 해서 환불/재시도 처리.
-- (사전 가드는 호출자가 별도로 — 이 RPC 도착 시점엔 이미 Anthropic 호출 완료)
CREATE OR REPLACE FUNCTION charge_ai_usage(
  p_tenant_id     UUID,
  p_route         TEXT,
  p_model         TEXT,
  p_input_tokens  INT,
  p_output_tokens INT,
  p_user_email    TEXT
) RETURNS JSONB AS $$
DECLARE
  v_credits_per_usd INT;
  v_markup          NUMERIC;
  v_pricing         JSONB;
  v_input_price     NUMERIC;
  v_output_price    NUMERIC;
  v_cost_usd        NUMERIC;
  v_credits         INT;
  v_usage_id        UUID;
  v_new_balance     INT;
BEGIN
  -- 1) 가격 정책 로드
  SELECT credits_per_usd, ai_markup_ratio, ai_model_pricing
    INTO v_credits_per_usd, v_markup, v_pricing
    FROM platform_settings WHERE id = 1;

  v_pricing := v_pricing -> p_model;
  IF v_pricing IS NULL THEN
    RAISE EXCEPTION 'unknown model: % (platform_settings.ai_model_pricing 에 추가 필요)', p_model;
  END IF;
  v_input_price  := (v_pricing ->> 'input')::NUMERIC;
  v_output_price := (v_pricing ->> 'output')::NUMERIC;

  -- 2) 원가 → 크레딧 변환 (최소 1)
  v_cost_usd := (p_input_tokens * v_input_price + p_output_tokens * v_output_price) / 1000000.0;
  v_credits  := CEIL(v_cost_usd * v_markup * v_credits_per_usd)::INT;
  IF v_credits < 1 THEN v_credits := 1; END IF;

  -- 3) usage 박제
  INSERT INTO ai_usage_logs
    (tenant_id, route, model, input_tokens, output_tokens, cost_usd, credits_charged, user_email)
  VALUES
    (p_tenant_id, p_route, p_model, p_input_tokens, p_output_tokens, v_cost_usd, v_credits, p_user_email)
  RETURNING id INTO v_usage_id;

  -- 4) 잔액 차감 (atomic — balance >= v_credits 일 때만 성공)
  INSERT INTO tenant_credits (tenant_id, balance) VALUES (p_tenant_id, 0)
  ON CONFLICT (tenant_id) DO NOTHING;

  UPDATE tenant_credits
    SET balance = balance - v_credits, updated_at = now()
    WHERE tenant_id = p_tenant_id AND balance >= v_credits
    RETURNING balance INTO v_new_balance;

  IF v_new_balance IS NULL THEN
    -- 잔액 부족 — usage 박제는 남기되 차감 안 됨. 호출자가 사전 가드 필요.
    -- (이 경우 usage_id 로 audit 가능 but charge tx 는 없음)
    RAISE EXCEPTION '크레딧 잔액 부족 (usage_id=%)', v_usage_id
      USING ERRCODE = 'P0001';
  END IF;

  -- 5) credit_transactions 박제
  INSERT INTO credit_transactions
    (tenant_id, kind, amount, balance_after, related_usage_id)
  VALUES
    (p_tenant_id, 'charge', -v_credits, v_new_balance, v_usage_id);

  RETURN jsonb_build_object(
    'credits_charged', v_credits,
    'balance_after',   v_new_balance,
    'cost_usd',        v_cost_usd,
    'usage_id',        v_usage_id
  );
END;
$$ LANGUAGE plpgsql;

-- ── 6. RPC: grant_credits ───────────────────────────────────
-- admin(super_admin) 수동 부여 / 결제 webhook(추후) 진입점.
-- kind: 'admin_grant' | 'topup' | 'refund'. 'charge' 는 charge_ai_usage 만.
CREATE OR REPLACE FUNCTION grant_credits(
  p_tenant_id UUID,
  p_amount    INT,
  p_kind      TEXT,
  p_note      TEXT DEFAULT NULL
) RETURNS JSONB AS $$
DECLARE
  v_new_balance INT;
BEGIN
  IF p_amount = 0 THEN
    RAISE EXCEPTION 'amount 0 은 허용되지 않습니다';
  END IF;
  IF p_kind NOT IN ('admin_grant', 'topup', 'refund') THEN
    RAISE EXCEPTION 'kind 는 admin_grant/topup/refund 중 하나여야 합니다 (charge 는 RPC charge_ai_usage 만)';
  END IF;

  INSERT INTO tenant_credits (tenant_id, balance)
    VALUES (p_tenant_id, GREATEST(p_amount, 0))
  ON CONFLICT (tenant_id) DO UPDATE
    SET balance = tenant_credits.balance + p_amount, updated_at = now()
  RETURNING balance INTO v_new_balance;

  IF v_new_balance < 0 THEN
    RAISE EXCEPTION '잔액 음수 — 차감 거부 (현재 %, 시도 %)',
      v_new_balance - p_amount, p_amount;
  END IF;

  INSERT INTO credit_transactions
    (tenant_id, kind, amount, balance_after, note)
  VALUES
    (p_tenant_id, p_kind, p_amount, v_new_balance, p_note);

  RETURN jsonb_build_object('balance_after', v_new_balance);
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION charge_ai_usage IS
  'AI 호출 후 정산. usage 박제 + 잔액 차감 + tx 박제 atomic. 잔액 부족 시 P0001 예외.';
COMMENT ON FUNCTION grant_credits IS
  '크레딧 부여/충전/환불. admin 수동 + 결제 webhook(v2) 진입점. charge 는 금지.';
