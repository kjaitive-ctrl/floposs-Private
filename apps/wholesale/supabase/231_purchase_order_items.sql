-- ============================================================
-- 231: 주문(사입 발주) 시트 — purchase_order_items
--
-- 작성: 2026-07-31
-- 배경: retail-site "주문" 탭 — 엑셀형으로 상품명/도매상품명/옵션/단가/
--   수량/거래처를 적어두고, 거래처별로 화면을 스크린샷해서 카톡 등으로
--   수동 전송하는 개인 작업 시트. 아직 미운영인 정식 발주(order_notes,
--   등록 공급사 slot) 시스템과는 별개 — 그쪽은 나중에 이걸 대체할 수도
--   있지만 지금은 가볍게 텍스트 스냅샷 기반으로 둠(사장님 확정).
-- 상품명/도매상품명/단가/거래처는 products 에서 골랐을 때 자동으로
--   채워지는 "스냅샷"일 뿐 — product 가 나중에 바뀌거나 지워져도 이미
--   적어둔 주문행은 그대로 남아야 해서 텍스트로 박제(라이브 조인 아님).
-- 자식 레코드가 이 테이블을 참조하는 곳이 없어서 완전삭제로 충분
--   ([[feedback_soft_delete_persistent_rows]] 원칙의 예외 케이스).
-- ============================================================

BEGIN;

CREATE TABLE IF NOT EXISTS purchase_order_items (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  product_id      UUID REFERENCES products(id) ON DELETE SET NULL,  -- 참고용 — 스냅샷이 주 데이터
  product_name    TEXT,    -- 상품명 (products.consumer_name 우선, 없으면 wholesale_name)
  wholesale_name  TEXT,    -- 도매상품명
  variant_label   TEXT,    -- 옵션 표시 (예: "블랙 / F")
  supplier_name   TEXT,    -- 거래처 — 자유텍스트(등록 공급사 아니어도 됨)
  unit_price      BIGINT,  -- 단가 (자동채움 후 수정 가능)
  quantity        INT NOT NULL DEFAULT 0,
  sort_order      INT NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE purchase_order_items DISABLE ROW LEVEL SECURITY;
CREATE INDEX IF NOT EXISTS idx_purchase_order_items_tenant ON purchase_order_items(tenant_id, sort_order);

DO $$ BEGIN
  RAISE NOTICE '[231] 주문(사입 발주) 시트 테이블 purchase_order_items 반영.';
END $$;

COMMIT;
