-- ============================================================
-- 212: slot 보드 클레임 (도매 자가입력 게이트 v1)
--
-- 작성: 2026-06-08
-- 도매 출고피드백(C) = claim gate. 도매가 자기 slot 보드(/s/<code>)를 클레임 →
--   전화매칭(slot_stores 전화)으로 비번 설정 → 이후 비번 로그인 → 상세+출고수량 입력.
-- 인증 = slot별 Supabase Auth 보드계정(email=slot-<code>@board.floposs.local).
-- 클레임 = 임시 도매 tenant(tenant_type='wholesale', is_provisional=true) 생성 → admin 도매업체관리에 "임시아이디"로 노출.
--   정식 wholesale POS 전환 시 tenant.id 그대로 승계. [[project_logi_axis]]
-- 출고수량/메모 컬럼은 마이그 210(order_note_items.shipped_quantity/ship_memo)에 이미 있음.
-- 신규 테이블 없음 — slots / tenants ALTER 만.
-- ============================================================

BEGIN;

ALTER TABLE slots
  ADD COLUMN IF NOT EXISTS board_claimed_at   TIMESTAMPTZ,                          -- 클레임 시각 (NULL=미클레임 → 보드 티저만)
  ADD COLUMN IF NOT EXISTS board_claim_phone  TEXT,                                 -- 클레임에 사용된 매장 전화(매칭 기록·admin 리셋용)
  ADD COLUMN IF NOT EXISTS board_tenant_id    UUID REFERENCES tenants(id) ON DELETE SET NULL;  -- 클레임한 임시 도매 tenant

-- 임시(보드) 도매 계정 표식 — admin 도매업체관리에서 정식/임시 구분.
ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS is_provisional BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN slots.board_claimed_at IS
  '도매 보드 클레임 시각. NULL=미클레임. 인증 = slot-<public_code>@board.floposs.local Supabase Auth 계정.';
COMMENT ON COLUMN tenants.is_provisional IS
  'true = 보드 클레임으로 생긴 임시 도매 계정(아이디=slot-<code>@board.floposs.local). 정식 wholesale 전환 시 false.';

CREATE INDEX IF NOT EXISTS idx_tenants_provisional ON tenants(is_provisional) WHERE is_provisional;

DO $$ BEGIN
  RAISE NOTICE '[212] slots.board_* + tenants.is_provisional 박힘 — 도매 보드 클레임(임시 tenant).';
END $$;

COMMIT;
