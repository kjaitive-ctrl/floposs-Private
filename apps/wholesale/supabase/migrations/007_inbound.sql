-- 입고전표 (한 번의 입고 건)
CREATE TABLE IF NOT EXISTS inbound_orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  inbound_date DATE NOT NULL DEFAULT CURRENT_DATE,
  supplier_id UUID REFERENCES customers(id),
  memo TEXT,
  total_amount NUMERIC(12,0) DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- 입고항목 (전표별 상품옵션 행)
CREATE TABLE IF NOT EXISTS inbound_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  inbound_order_id UUID NOT NULL REFERENCES inbound_orders(id) ON DELETE CASCADE,
  variant_id UUID NOT NULL REFERENCES product_variants(id),
  quantity INTEGER NOT NULL DEFAULT 0,
  unit_price NUMERIC(12,0) DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- 입고항목 수정기록
CREATE TABLE IF NOT EXISTS inbound_item_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  inbound_item_id UUID NOT NULL REFERENCES inbound_items(id) ON DELETE CASCADE,
  changed_field TEXT NOT NULL,
  old_value TEXT,
  new_value TEXT,
  changed_at TIMESTAMPTZ DEFAULT now()
);

-- RLS 비활성화 (개발용)
ALTER TABLE inbound_orders DISABLE ROW LEVEL SECURITY;
ALTER TABLE inbound_items DISABLE ROW LEVEL SECURITY;
ALTER TABLE inbound_item_logs DISABLE ROW LEVEL SECURITY;
