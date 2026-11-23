-- ============================================================
-- 242: 스타일링 시트 + 엑셀형 자유 메모 + 주문 샘플요청 → 입고 시 샘플 탭 자동 등록
--
-- 작성: 2026-11-23
-- 흐름 (사장 결정):
--   ① 스타일링 탭: 줄 = 코디 1벌. 메모 + 하의/상의(이너)/상의(아우터)/아우터/소품·가방/신발 칸.
--      칸마다 후보 샘플 1개 (매장명·상품명·컬러·단가).
--   ② [주문서로] → purchase_order_items 에 "샘플요청" 줄로 들어감 (is_sample_request).
--   ③ **입고 시에만** 샘플 탭(products, status=sample_received)으로 넘어감 → RPC po_receive_sample.
--      상품번호(R-xxx) 발급·옵션(컬러) 생성을 DB 에서 한 번에 (동시 입력에도 번호 안 꼬임).
--   자유 메모: free_sheet_cells — 엑셀처럼 아무 칸에나 쓰는 메모(트렌드 탭 등). sheet_key 로 화면 구분.
-- 원칙: 소프트삭제(deleted_at), RLS 비활성 (+ 241 처럼 재활성 함정 대비 맨 끝에서 한 번 더 DISABLE).
-- ============================================================

BEGIN;

-- ── 엑셀형 자유 메모 ──
CREATE TABLE IF NOT EXISTS free_sheet_cells (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  sheet_key   TEXT NOT NULL,              -- 예: 'trend_memo'
  row_idx     INT  NOT NULL,
  col_idx     INT  NOT NULL,
  text        TEXT NOT NULL DEFAULT '',
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, sheet_key, row_idx, col_idx)
);
CREATE INDEX IF NOT EXISTS idx_free_sheet_cells_sheet ON free_sheet_cells(tenant_id, sheet_key);

-- ── 스타일링: 코디 줄 ──
CREATE TABLE IF NOT EXISTS styling_looks (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  memo        TEXT NOT NULL DEFAULT '',
  sort_order  INT  NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at  TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_styling_looks_tenant ON styling_looks(tenant_id, deleted_at, sort_order);

-- ── 스타일링: 칸(후보 샘플) ──
CREATE TABLE IF NOT EXISTS styling_cells (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  look_id       UUID NOT NULL REFERENCES styling_looks(id) ON DELETE CASCADE,
  slot          TEXT NOT NULL CHECK (slot IN ('bottom','top_inner','top_outer','outer','acc','shoes')),
  store_name    TEXT,     -- 매장명 (자유 입력)
  product_name  TEXT,     -- 상품명 (매장 상품명)
  color         TEXT,
  unit_price    BIGINT,
  order_item_id UUID REFERENCES purchase_order_items(id) ON DELETE SET NULL,  -- [주문서로] 보낸 줄
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (look_id, slot)
);
CREATE INDEX IF NOT EXISTS idx_styling_cells_look ON styling_cells(look_id);

-- ── 주문 줄: 샘플요청 표시 + 연결 ──
ALTER TABLE purchase_order_items
  ADD COLUMN IF NOT EXISTS is_sample_request BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS styling_cell_id   UUID REFERENCES styling_cells(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS sample_product_id UUID REFERENCES products(id) ON DELETE SET NULL;
COMMENT ON COLUMN purchase_order_items.is_sample_request IS '스타일링 [주문서로] 로 들어온 샘플요청 줄';
COMMENT ON COLUMN purchase_order_items.sample_product_id IS '입고 시 샘플 탭에 만들어진 상품 (po_receive_sample)';

-- ── 입고 시 샘플 탭 등록 ──
CREATE OR REPLACE FUNCTION po_receive_sample(p_item_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
AS $$
DECLARE
  it        purchase_order_items%ROWTYPE;
  v_name    TEXT;
  v_color   TEXT;
  v_store   TEXT;
  v_sup     retail_suppliers%ROWTYPE;
  v_next    INT;
  v_code    TEXT;
  v_pid     UUID;
  v_today   DATE := (now() AT TIME ZONE 'Asia/Seoul')::date;
BEGIN
  SELECT * INTO it FROM purchase_order_items WHERE id = p_item_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION '주문 줄을 찾을 수 없습니다'; END IF;
  IF NOT it.is_sample_request THEN RAISE EXCEPTION '샘플요청 줄이 아닙니다'; END IF;
  IF COALESCE(it.received_quantity, 0) <= 0 THEN RAISE EXCEPTION '입고수량이 없습니다'; END IF;

  -- 이미 등록됐으면 그대로 돌려줌 (두 번 눌러도 한 번만)
  IF it.sample_product_id IS NOT NULL THEN
    SELECT product_code INTO v_code FROM products WHERE id = it.sample_product_id;
    RETURN jsonb_build_object('product_id', it.sample_product_id, 'product_code', v_code, 'already', true);
  END IF;

  v_name  := COALESCE(NULLIF(trim(it.wholesale_name), ''), NULLIF(trim(it.product_name), ''), '이름 없음');
  v_color := NULLIF(trim(it.variant_label), '');
  v_store := NULLIF(trim(it.supplier_name), '');

  -- 매장명이 등록 거래처 별명과 같으면 연결 (아니면 설명에 매장명만 남김 — 미연결 자유텍스트 박제 금지 원칙)
  IF v_store IS NOT NULL THEN
    SELECT * INTO v_sup FROM retail_suppliers
     WHERE retail_tenant_id = it.tenant_id AND lower(trim(alias)) = lower(v_store)
     LIMIT 1;
  END IF;

  -- 상품번호 R-xxx: 매장 단위 잠금 후 최대+1
  PERFORM pg_advisory_xact_lock(hashtext(it.tenant_id::text || ':product_code'));
  SELECT COALESCE(MAX(NULLIF(regexp_replace(product_code, '[^0-9]', '', 'g'), '')::INT), 0) + 1
    INTO v_next FROM products WHERE tenant_id = it.tenant_id AND product_code LIKE 'R-%';
  v_code := 'R-' || lpad(v_next::text, 3, '0');

  INSERT INTO products (
    tenant_id, product_code, name, wholesale_name,
    wholesale_supplier, retail_supplier_id,
    wholesale_price, launch_date, return_deadline, status,
    description, option1_label, is_active
  ) VALUES (
    it.tenant_id, v_code, v_name, v_name,
    CASE WHEN v_sup.id IS NOT NULL THEN v_store END, v_sup.id,
    it.unit_price, v_today, v_today + 14, 'sample_received',
    CASE WHEN v_sup.id IS NULL AND v_store IS NOT NULL THEN '매장: ' || v_store END,
    CASE WHEN v_color IS NOT NULL THEN '색상' END, true
  ) RETURNING id INTO v_pid;

  IF v_color IS NOT NULL THEN
    INSERT INTO product_variants (product_id, color, sort_order) VALUES (v_pid, v_color, 1);
  END IF;

  UPDATE purchase_order_items
     SET sample_product_id = v_pid,
         product_id = COALESCE(product_id, v_pid),
         updated_at = now()
   WHERE id = p_item_id;

  RETURN jsonb_build_object('product_id', v_pid, 'product_code', v_code, 'already', false);
END $$;

GRANT EXECUTE ON FUNCTION po_receive_sample(UUID) TO anon, authenticated;

COMMIT;

-- RLS: 새 표는 Supabase 가 다시 켤 수 있어 트랜잭션 밖에서 한 번 더 끔 (241 함정)
ALTER TABLE free_sheet_cells DISABLE ROW LEVEL SECURITY;
ALTER TABLE styling_looks    DISABLE ROW LEVEL SECURITY;
ALTER TABLE styling_cells    DISABLE ROW LEVEL SECURITY;

SELECT relname, relrowsecurity FROM pg_class
 WHERE relname IN ('free_sheet_cells', 'styling_looks', 'styling_cells');
