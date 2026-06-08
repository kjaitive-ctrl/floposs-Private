-- ============================================================
-- 210: logi(물류/사입삼촌) 축 v1 — 픽업 루프 스키마 (추가형)
--
-- 작성: 2026-06-08
-- 회의 결론 [[project_logi_axis]]:
--   - logi = order_notes 의 또 다른 렌즈. 새 주문 테이블 X, 기존 노트에 픽업 소켓만 얹음.
--   - 삼촌 배정 = 물류회사(tenant_type='logistics') 단위. retail 이 회사 1곳 계약.
--   - 픽업 단위 = note(retail×slot) → order_notes 에 pickup_status.
--   - 도매 출고 피드백 = order_note_items 에 shipped_quantity/ship_memo (표시 소켓, 입력 UI 는 동결 풀릴 때).
--   - tenant_type='logistics' 는 마이그 175 CHECK 에 이미 허용 → 제약 ALTER 불필요.
--   - 본 마이그 = ALTER + 시드만. 신규 테이블 없음(RLS 함정 해당 X).
-- ============================================================

BEGIN;

-- ① account_types 에 'logistics' 등록 (admin 라벨/필터용)
--    is_signup_enabled=false — logi 계정은 admin(삼촌계정관리)이 발급, 자가가입 X.
--    dashboard_route='__logi__' — 클라이언트가 NEXT_PUBLIC_LOGI_SITE_URL 로 해석 (retail '__retail__' 패턴).
INSERT INTO account_types (code, label, description, dashboard_route, is_signup_enabled, display_order) VALUES
  ('logistics', '물류(사입)', '사입삼촌/물류 — 상가 픽업 요청 수신 및 픽업 처리', '__logi__', false, 3)
ON CONFLICT (code) DO NOTHING;


-- ② retail tenant → 계약한 물류회사 (기본 1곳)
--    retail submit 시 order_notes.logi_tenant_id 로 박제. tenant_type='retail' 에서만 의미.
ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS default_logi_tenant_id UUID REFERENCES tenants(id) ON DELETE SET NULL;

COMMENT ON COLUMN tenants.default_logi_tenant_id IS
  'retail 이 계약한 물류회사(tenant_type=logistics) tenant.id. 발주 시 order_notes.logi_tenant_id 로 박제. (여러 삼촌은 logi 회사 내부 분배 — 나중)';


-- ③ order_notes — 픽업 소켓 (note = retail×slot = 픽업 1건)
ALTER TABLE order_notes
  ADD COLUMN IF NOT EXISTS logi_tenant_id UUID REFERENCES tenants(id) ON DELETE SET NULL,  -- 배정된 물류회사
  ADD COLUMN IF NOT EXISTS pickup_status  TEXT NOT NULL DEFAULT 'pending',                 -- pending / picked / failed
  ADD COLUMN IF NOT EXISTS picked_at      TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS pickup_memo    TEXT;

-- pickup_status 값 제약 (ADD COLUMN 과 분리 — IF NOT EXISTS 재실행 안전)
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'order_notes_pickup_status_check') THEN
    ALTER TABLE order_notes
      ADD CONSTRAINT order_notes_pickup_status_check
      CHECK (pickup_status IN ('pending','picked','failed'));
  END IF;
END $$;

-- logi 픽업 리스트 조회 인덱스 (배정된 노트만)
CREATE INDEX IF NOT EXISTS idx_order_notes_logi
  ON order_notes(logi_tenant_id, sent_at DESC)
  WHERE logi_tenant_id IS NOT NULL;


-- ④ order_note_items — 도매 출고 피드백 (표시 소켓)
--    ⚠️ 메모장 피드백일 뿐. 진짜 매출/출고 박제는 wholesale POS 처리(163~169)에서. 이중진실 금지.
ALTER TABLE order_note_items
  ADD COLUMN IF NOT EXISTS shipped_quantity INT,   -- 도매가 회신한 출고수량 (NULL=미회신)
  ADD COLUMN IF NOT EXISTS ship_memo        TEXT;  -- "OO일 입고예정" 등


DO $$ BEGIN
  RAISE NOTICE '[210] logi 픽업 스키마 박힘 — account_types(logistics) + tenants.default_logi_tenant_id + order_notes(픽업) + order_note_items(출고피드백).';
END $$;

COMMIT;
