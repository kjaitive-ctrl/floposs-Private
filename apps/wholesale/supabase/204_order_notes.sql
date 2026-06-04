-- ============================================================
-- 204: 전자노트(외부 발주 노트) — 안건3 C4 Phase A (스키마)
--
-- 작성: 2026-06-02
-- 회의 결론:
--   - 단위 = slot 주소 (거래처별 전송, 미가입 도매도 누적 → 클레임 시 승격) [결정1=A]
--   - 단가 = 전송 시점 도매가 박제(불변) + 내상품 가격편집은 다음 전송부터 [결정2/A]
--   - retail = 자기 발신만 / wholesale = 자기 수신만 (각자 뷰, soft-hide 각자) [결정3/D]
--   - 재전송 가능 + 누적 [결정4]
--   - 풀(pull) 모델 — "전송" = 노트 박제. 도매는 pull(POS/URL). 카톡 자동발송 불필요.
--   - 처리회신(도매→retail 출고/일정)은 v4 — 지금은 nullable 소켓만 [ㄴ]
--   - is_test 로 dev 테스트 격리 [Q3]
-- 본 마이그 = 테이블 2개만(추가형). submit 배선/뷰/클레임은 후속 Phase.
-- [[project_retail_slot_order_portal_v2]]
-- ============================================================

BEGIN;

-- ① order_notes — 발신 retail × 수신 slot 단위 (거래처별 1전송)
CREATE TABLE IF NOT EXISTS order_notes (
  id                            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sender_retail_tenant_id       UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  sender_retail_supplier_id     UUID REFERENCES retail_suppliers(id) ON DELETE SET NULL, -- retail측 거래처 매핑(있으면)
  recipient_slot_id             UUID NOT NULL REFERENCES slots(id) ON DELETE RESTRICT,    -- 수신 자리(도매) — 클레임 키
  recipient_wholesale_tenant_id UUID REFERENCES tenants(id) ON DELETE SET NULL,           -- 클레임 승인 시 채움 (nullable)
  sent_at                       TIMESTAMPTZ NOT NULL DEFAULT now(),                       -- 확정/전송 시각 (주문내역 날짜그룹)
  status                        TEXT NOT NULL DEFAULT 'sent',  -- sent / converted / canceled
  is_hidden                     BOOLEAN NOT NULL DEFAULT false, -- wholesale 수신 뷰 숨김
  sender_hidden                 BOOLEAN NOT NULL DEFAULT false, -- retail 발신 뷰 숨김 (각자 뷰)
  is_test                       BOOLEAN NOT NULL DEFAULT false, -- dev 테스트 격리 (나중 일괄 청소)
  memo                          TEXT,                           -- 자유 메모 (전자노트 = 메모장)
  created_at                    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                    TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE order_notes DISABLE ROW LEVEL SECURITY;  -- 개발 단계 (신규 테이블 RLS 자동활성 차단)

CREATE INDEX IF NOT EXISTS idx_order_notes_slot      ON order_notes(recipient_slot_id);
CREATE INDEX IF NOT EXISTS idx_order_notes_sender    ON order_notes(sender_retail_tenant_id, sent_at DESC);
CREATE INDEX IF NOT EXISTS idx_order_notes_wholesale ON order_notes(recipient_wholesale_tenant_id) WHERE recipient_wholesale_tenant_id IS NOT NULL;


-- ② order_note_items — 노트 라인 (스냅샷 박제 + 단가 + 식별/처리회신 소켓)
CREATE TABLE IF NOT EXISTS order_note_items (
  id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  note_id                   UUID NOT NULL REFERENCES order_notes(id) ON DELETE CASCADE,
  -- 식별자 소켓 (retail측 PK + 미래 lazy matching/v3)
  retail_product_id         UUID REFERENCES products(id) ON DELETE SET NULL,
  retail_variant_id         UUID REFERENCES product_variants(id) ON DELETE SET NULL,
  -- 전송 시점 스냅샷 박제 (상품/옵션 변경·삭제에도 불변 — 영수증 박제 원칙)
  supplier_product_name     TEXT,   -- 공급사 상품명 (wholesale_name)
  consumer_product_name     TEXT,   -- 내 상품명 (consumer_name)
  supplier_option_label     TEXT,   -- 색/사이즈/옵션3
  consumer_option_label     TEXT,   -- 내 옵션
  variant_barcode           TEXT,   -- variant 바코드 (식별 보조)
  quantity                  INT  NOT NULL CHECK (quantity > 0),
  unit_price                NUMERIC NOT NULL DEFAULT 0,  -- 전송 시점 도매가 박제 [결정2]
  -- 처리회신 소켓 (v4 — 도매 처리결과 회신. 지금은 nullable, 기능 미구현) [ㄴ]
  processing_status         TEXT,
  processed_at              TIMESTAMPTZ,
  linked_order_item_id      UUID REFERENCES order_items(id) ON DELETE SET NULL,  -- 클레임 변환 시 wholesale order_item 링크
  created_at                TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE order_note_items DISABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS idx_order_note_items_note ON order_note_items(note_id);


DO $$ BEGIN
  RAISE NOTICE '[204] 전자노트 스키마 박힘 — order_notes / order_note_items. (submit 배선은 후속 Phase)';
END $$;

COMMIT;
