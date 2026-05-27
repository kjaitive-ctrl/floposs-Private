-- ============================================================
-- 082: 문의 게시판 (CS) — tenant/retail → super_admin
--
-- 배경: 영업 중 직접 전화/카톡 문의 부담을 줄이기 위해 비동기 게시판형
--       문의 시스템. 도매 사장/직원, 소매 retailer 가 각자 dashboard 에서
--       문의 작성 → super_admin 의 /admin/inquiries 로 모두 모임.
--
-- 정책:
--   - 모든 plat 의 문의가 한 테이블에 모임 (kind 로 구분 안 함, author 출처로 구분).
--   - tenant_id / retailer_id 둘 중 하나만 채워짐 (작성자 출처).
--   - status: 'open'(접수)/'in_progress'(처리중)/'resolved'(해결)/'closed'(종결)
--   - 답변(replies)은 별도 테이블 — 작성자 추가 코멘트 + super_admin 답변 모두.
--   - is_admin_reply=true 면 super_admin 답변, false 면 작성자 추가 댓글.
--   - 작성자는 본인 문의만 조회 (RLS 추후, 지금은 client 에서 필터).
--   - super_admin 은 전체 조회/답변/상태 변경.
-- ============================================================

CREATE TABLE IF NOT EXISTS inquiries (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- 작성자
  author_email    TEXT NOT NULL,
  author_role     TEXT NOT NULL,                -- 'tenant_admin' / 'staff' / 'retailer_admin'
  -- 작성자 소속 (둘 중 하나만)
  tenant_id       UUID REFERENCES tenants(id) ON DELETE SET NULL,
  retailer_id     UUID,                         -- retail_retailers FK (별도 schema 라 직접 FK 안 검)
  -- 내용
  category        TEXT NOT NULL DEFAULT 'general'
                    CHECK (category IN ('general', 'billing', 'technical', 'feature', 'other')),
  title           TEXT NOT NULL,
  body            TEXT NOT NULL,
  -- 상태
  status          TEXT NOT NULL DEFAULT 'open'
                    CHECK (status IN ('open', 'in_progress', 'resolved', 'closed')),
  -- 메타
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- 마지막 활동 (정렬/알림용)
  last_activity_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_inquiries_status_activity
  ON inquiries (status, last_activity_at DESC);
CREATE INDEX IF NOT EXISTS idx_inquiries_tenant
  ON inquiries (tenant_id, last_activity_at DESC) WHERE tenant_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_inquiries_retailer
  ON inquiries (retailer_id, last_activity_at DESC) WHERE retailer_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_inquiries_author_email
  ON inquiries (author_email, last_activity_at DESC);

ALTER TABLE inquiries DISABLE ROW LEVEL SECURITY;

-- updated_at 자동
CREATE OR REPLACE FUNCTION inquiries_touch_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_inquiries_updated_at ON inquiries;
CREATE TRIGGER trg_inquiries_updated_at
  BEFORE UPDATE ON inquiries
  FOR EACH ROW EXECUTE FUNCTION inquiries_touch_updated_at();

-- ── 답변 테이블 ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS inquiry_replies (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  inquiry_id      UUID NOT NULL REFERENCES inquiries(id) ON DELETE CASCADE,
  -- 답변자
  responder_email TEXT NOT NULL,
  responder_role  TEXT NOT NULL,                -- 'super_admin' / 'tenant_admin' / 'staff' / 'retailer_admin'
  is_admin_reply  BOOLEAN NOT NULL DEFAULT false,  -- super_admin 답변이면 true, 작성자 추가 코멘트면 false
  -- 내용
  body            TEXT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_inquiry_replies_inquiry
  ON inquiry_replies (inquiry_id, created_at);

ALTER TABLE inquiry_replies DISABLE ROW LEVEL SECURITY;

-- 답변 INSERT 시 inquiries.last_activity_at 자동 갱신
CREATE OR REPLACE FUNCTION inquiry_replies_touch_parent()
RETURNS TRIGGER AS $$
BEGIN
  UPDATE inquiries
  SET last_activity_at = now(),
      -- super_admin 이 답변하면 자동으로 in_progress (open 일 때만)
      status = CASE
        WHEN NEW.is_admin_reply AND status = 'open' THEN 'in_progress'
        ELSE status
      END
  WHERE id = NEW.inquiry_id;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_inquiry_replies_touch ON inquiry_replies;
CREATE TRIGGER trg_inquiry_replies_touch
  AFTER INSERT ON inquiry_replies
  FOR EACH ROW EXECUTE FUNCTION inquiry_replies_touch_parent();

-- ── 코멘트 ───────────────────────────────────────────
COMMENT ON TABLE inquiries IS
  '문의 게시판 본문. tenant/retail → super_admin. status 로 처리 흐름 추적.';
COMMENT ON TABLE inquiry_replies IS
  '문의 답변/추가 코멘트. is_admin_reply=true 면 super_admin 답변. INSERT 시 부모 last_activity_at 자동 갱신.';
