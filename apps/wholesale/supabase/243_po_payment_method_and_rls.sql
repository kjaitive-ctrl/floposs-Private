-- ============================================================
-- 243: 주문 결제방식(이체/현금) + 242 새 표 RLS 재비활성화
--
-- 작성: 2026-11-23
-- 1) purchase_order_items.payment_method — 기본 '이체(transfer)', 현금(cash) 선택 가능.
-- 2) 242 에서 만든 표 3개 RLS 가 Supabase 에 의해 다시 켜짐 → 별도 실행으로 다시 끔.
--    (같은 실행 안 맨 끝에서 꺼도 다시 켜지는 것 확인 — 표 만든 뒤 "따로" 한 번 더 실행해야 유지됨)
--    [[feedback_supabase_new_table_rls]]
-- ============================================================

ALTER TABLE purchase_order_items
  ADD COLUMN IF NOT EXISTS payment_method TEXT NOT NULL DEFAULT 'transfer'
    CHECK (payment_method IN ('transfer', 'cash'));
COMMENT ON COLUMN purchase_order_items.payment_method IS '결제방식: transfer=이체(기본), cash=현금';

ALTER TABLE free_sheet_cells DISABLE ROW LEVEL SECURITY;
ALTER TABLE styling_looks    DISABLE ROW LEVEL SECURITY;
ALTER TABLE styling_cells    DISABLE ROW LEVEL SECURITY;

SELECT relname, relrowsecurity FROM pg_class
 WHERE relname IN ('free_sheet_cells', 'styling_looks', 'styling_cells');
