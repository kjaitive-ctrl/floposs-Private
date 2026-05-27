-- =============================================
-- WHOLESALE POS — 현재 전체 스키마 (최신 상태)
-- =============================================
-- 이 파일은 DB 현재 상태의 단일 소스입니다.
-- 과거 마이그레이션 파일: supabase/migrations/
-- =============================================


-- ── 구독 플랜 ────────────────────────────────
CREATE TABLE IF NOT EXISTS subscription_plans (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name             TEXT NOT NULL,
  description      TEXT,
  price            NUMERIC(10,2) NOT NULL DEFAULT 0,
  billing_cycle    TEXT NOT NULL DEFAULT 'monthly' CHECK (billing_cycle IN ('monthly', 'yearly', 'one_time')),
  features         JSONB NOT NULL DEFAULT '[]',
  is_active        BOOLEAN NOT NULL DEFAULT true,
  sort_order       INT NOT NULL DEFAULT 0,
  -- 마이그 189: vertical 별 플랜 풀 분리 (wholesale/retail/...)
  vertical         TEXT NOT NULL DEFAULT 'wholesale' CHECK (vertical IN (
    'wholesale','retail','logistics','designer','platform','restaurant','other'
  )),
  created_at       TIMESTAMPTZ DEFAULT now()
);


-- ── 업체 (테넌트) ─────────────────────────────
CREATE TABLE IF NOT EXISTS tenants (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- 마이그 175: tenant_type CHECK 5축 가치사슬 확장
  tenant_type              TEXT NOT NULL CHECK (tenant_type IN (
    'wholesale','retail','logistics','designer','platform','restaurant','other'
  )),
  company_name             TEXT NOT NULL,    -- retail: 업체명(상호) / wholesale: 매장명
  business_number          TEXT UNIQUE,
  owner_name               TEXT,
  phone                    TEXT,
  address                  TEXT,             -- retail: 사무실주소 / wholesale: 매장 주소
  biz_address              TEXT,             -- 사업자등록증 주소
  -- 플랜 연동
  plan_id                  UUID REFERENCES subscription_plans(id),
  subscription_expires_at  TIMESTAMPTZ,
  cancel_at_period_end     BOOLEAN NOT NULL DEFAULT false,
  -- 업체 정보
  category                 TEXT NOT NULL DEFAULT 'wholesale',
  admin_note               TEXT,
  is_active                BOOLEAN NOT NULL DEFAULT true,
  -- 설정
  sample_period_days       INT NOT NULL DEFAULT 7,
  -- 마이그 101: 입금받을 은행계좌 (메인/서브) + 매장위치 구조화
  main_bank_name           TEXT,
  main_bank_account        TEXT,
  main_bank_holder         TEXT,
  sub_bank_name            TEXT,
  sub_bank_account         TEXT,
  sub_bank_holder          TEXT,
  store_building           TEXT,
  store_floor_unit         TEXT,
  store_name               TEXT,             -- 매장명 (wholesale) / 쇼핑몰명 (retail)
  -- 마이그 175: retail 매장 정보 박제 컬럼
  default_payment_method   TEXT CHECK (default_payment_method IS NULL
                              OR default_payment_method IN ('cash','transfer','credit')),
  last_order_at            TIMESTAMPTZ,
  -- 마이그 189: retail 내정보 확장
  tax_invoice_email        TEXT,             -- 세금계산서 발행용
  contact_email            TEXT,             -- 담당자 연락용 (dummy auth email 과 별개)
  warehouse_address        TEXT,             -- 물류/매장 주소
  warehouse_same_as_office BOOLEAN NOT NULL DEFAULT true,
  warehouse_phone          TEXT,
  store_url                TEXT,             -- 온라인 쇼핑몰 URL
  created_at               TIMESTAMPTZ DEFAULT now(),
  updated_at               TIMESTAMPTZ DEFAULT now()
);


-- ── 사용자 ───────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  email         TEXT UNIQUE NOT NULL,
  name          TEXT NOT NULL,
  phone         TEXT,
  role          TEXT NOT NULL DEFAULT 'staff' CHECK (role IN ('super_admin', 'tenant_admin', 'manager', 'staff')),
  is_active     BOOLEAN DEFAULT true,
  last_login_at TIMESTAMPTZ,
  created_at    TIMESTAMPTZ DEFAULT now(),
  updated_at    TIMESTAMPTZ DEFAULT now()
);


-- ── 역할 / 권한 ──────────────────────────────
CREATE TABLE IF NOT EXISTS roles (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID REFERENCES tenants(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  description TEXT,
  created_at  TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS permissions (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  role_id     UUID NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  menu_key    TEXT NOT NULL,
  can_view    BOOLEAN DEFAULT false,
  can_create  BOOLEAN DEFAULT false,
  can_edit    BOOLEAN DEFAULT false,
  can_delete  BOOLEAN DEFAULT false
);


-- ── 도매↔소매 연결 ────────────────────────────
CREATE TABLE IF NOT EXISTS tenant_connections (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  wholesale_tenant_id UUID NOT NULL REFERENCES tenants(id),
  retail_tenant_id    UUID NOT NULL REFERENCES tenants(id),
  status              TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'active', 'suspended')),
  connected_at        TIMESTAMPTZ,
  created_at          TIMESTAMPTZ DEFAULT now()
);


-- ── 상품 카테고리 ─────────────────────────────
CREATE TABLE IF NOT EXISTS product_categories (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(tenant_id, name)
);


-- ── 상품 ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS products (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name                 TEXT NOT NULL,
  product_code         TEXT,
  category             TEXT,
  description          TEXT,
  base_price           NUMERIC(12,2) NOT NULL DEFAULT 0,
  cost_price           NUMERIC(12,2),
  sale_price           NUMERIC(12,2),
  is_sale              BOOLEAN DEFAULT false,
  material_composition JSONB DEFAULT '{}',   -- {"면": 70, "폴리": 30}
  fabric_details       JSONB DEFAULT '[]',   -- [{part, fabric}, ...]
  manufacturer         TEXT,
  designer             TEXT,
  fabric_source        TEXT,
  country_of_origin    TEXT,
  launch_date          DATE,
  is_active            BOOLEAN DEFAULT true,
  created_at           TIMESTAMPTZ DEFAULT now(),
  updated_at           TIMESTAMPTZ DEFAULT now(),
  UNIQUE(tenant_id, product_code)
);

CREATE TABLE IF NOT EXISTS product_images (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  url        TEXT NOT NULL,
  sort_order INT DEFAULT 0,
  is_main    BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS product_variants (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id       UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  color            TEXT,
  size             TEXT,
  sku              TEXT,
  barcode          TEXT,
  additional_price NUMERIC(12,2) DEFAULT 0,
  is_active        BOOLEAN DEFAULT true,
  created_at       TIMESTAMPTZ DEFAULT now(),
  UNIQUE(product_id, color, size)
);

CREATE TABLE IF NOT EXISTS product_measurements (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id   UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  size         TEXT NOT NULL,
  measurements JSONB DEFAULT '{}',
  UNIQUE(product_id, size)
);

CREATE TABLE IF NOT EXISTS product_customer_prices (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  product_id       UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  customer_id      UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  variant_id       UUID REFERENCES product_variants(id),
  negotiated_price NUMERIC(12,2) NOT NULL,
  valid_from       DATE,
  valid_until      DATE,
  created_at       TIMESTAMPTZ DEFAULT now(),
  updated_at       TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS product_mappings (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  variant_id            UUID NOT NULL REFERENCES product_variants(id) ON DELETE CASCADE,
  external_system       TEXT NOT NULL,
  external_tenant_id    UUID REFERENCES tenants(id),
  external_sku          TEXT,
  external_barcode      TEXT,
  external_product_name TEXT,
  external_option       TEXT,
  created_at            TIMESTAMPTZ DEFAULT now(),
  UNIQUE(variant_id, external_system, external_tenant_id)
);


-- ── 거래처 ───────────────────────────────────
CREATE TABLE IF NOT EXISTS customers (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  linked_tenant_id  UUID REFERENCES tenants(id),
  company_name      TEXT NOT NULL,
  business_name     TEXT,
  business_number   TEXT,
  tax_email         TEXT,
  owner_name        TEXT,
  phone             TEXT,
  email             TEXT,
  address           TEXT,
  contact1_name     TEXT,
  contact1_phone    TEXT,
  contact1_role     TEXT,
  contact2_name     TEXT,
  contact2_phone    TEXT,
  contact2_role     TEXT,
  credit_limit      NUMERIC(12,2) DEFAULT 0,
  outstanding_balance NUMERIC(12,2) DEFAULT 0,
  include_vat       BOOLEAN DEFAULT true,          -- 프론트 교체 후 제거 예정
  default_vat_mode  TEXT DEFAULT 'deferred'
    CHECK (default_vat_mode IN ('deferred', 'included', 'none')),
  memo              TEXT,
  is_active         BOOLEAN DEFAULT true,
  created_at        TIMESTAMPTZ DEFAULT now(),
  updated_at        TIMESTAMPTZ DEFAULT now()
);


-- ── 재고 ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS inventory (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  variant_id UUID NOT NULL REFERENCES product_variants(id) ON DELETE CASCADE,
  quantity   INT NOT NULL DEFAULT 0,
  location   TEXT,
  updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(tenant_id, variant_id)
);


-- ── 주문 / 판매 ──────────────────────────────
CREATE TABLE IF NOT EXISTS orders (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id              UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  customer_id            UUID NOT NULL REFERENCES customers(id),
  order_number           TEXT NOT NULL,
  order_type             TEXT DEFAULT 'wholesale' CHECK (order_type IN ('wholesale', 'bulk', 'retail_b2b')),
  order_source           TEXT DEFAULT 'internal',
  payment_method         TEXT CHECK (payment_method IN ('cash', 'transfer', 'credit')),
  status                 TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'confirmed', 'in_production', 'ready', 'shipped', 'delivered', 'cancelled')),
  total_amount           NUMERIC(12,2) DEFAULT 0,
  vat_amount             NUMERIC(12,2) DEFAULT 0,
  paid_amount            NUMERIC(12,2) DEFAULT 0,
  outstanding_amount     NUMERIC(12,2) DEFAULT 0,
  expected_delivery_date DATE,
  memo                   TEXT,
  created_by             UUID REFERENCES users(id),
  created_at             TIMESTAMPTZ DEFAULT now(),
  updated_at             TIMESTAMPTZ DEFAULT now(),
  UNIQUE(tenant_id, order_number)
);

CREATE TABLE IF NOT EXISTS order_items (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id    UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  variant_id  UUID NOT NULL REFERENCES product_variants(id),
  quantity    INT NOT NULL,
  unit_price  NUMERIC(12,2) NOT NULL,
  total_price NUMERIC(12,2) NOT NULL,
  is_backorder BOOLEAN DEFAULT false,
  item_type   TEXT DEFAULT 'ship' CHECK (item_type IN ('ship', 'backorder', 'order', 'sample')),
  status      TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'in_production', 'ready', 'shipped', 'delivered')),
  created_at  TIMESTAMPTZ DEFAULT now()
);


-- ── 현금 세션 (전기시재 / 차기시재) ─────────────────────────────
CREATE TABLE IF NOT EXISTS cash_sessions (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  session_date     DATE NOT NULL,
  opening_balance  NUMERIC(12,0) NOT NULL DEFAULT 0,
  opener_name      TEXT,
  opened_at        TIMESTAMPTZ DEFAULT now(),
  opened_by        UUID REFERENCES users(id),
  cash_in_total    NUMERIC(12,0),
  cash_out_total   NUMERIC(12,0),
  expected_closing NUMERIC(12,0),
  actual_closing   NUMERIC(12,0),
  difference       NUMERIC(12,0),
  closed_at        TIMESTAMPTZ,
  closed_by        UUID REFERENCES users(id),
  memo             TEXT,
  status           TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  UNIQUE (tenant_id, session_date)
);


-- ── 입출금 ───────────────────────────────────
CREATE TABLE IF NOT EXISTS transactions (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  customer_id      UUID REFERENCES customers(id),
  order_id         UUID REFERENCES orders(id),
  cash_session_id  UUID REFERENCES cash_sessions(id),
  type             TEXT NOT NULL CHECK (type IN ('income', 'expense', 'receivable', 'payable')),
  amount           NUMERIC(12,2) NOT NULL,
  method           TEXT CHECK (method IN ('cash', 'transfer', 'card', 'other')),
  description      TEXT,
  transaction_date DATE NOT NULL,
  vat_mode         TEXT CHECK (vat_mode IN ('deferred', 'included', 'none', 'vat_only')),
  vat_cleared      BOOLEAN DEFAULT false,
  vat_cleared_at   TIMESTAMPTZ,
  created_by       UUID REFERENCES users(id),
  created_at       TIMESTAMPTZ DEFAULT now()
);

-- ── 부가세 배치 ──────────────────────────────
CREATE TABLE IF NOT EXISTS vat_batches (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  customer_id   UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  period_month  TEXT NOT NULL CHECK (period_month ~ '^\d{4}-\d{2}$'),
  base_amount   NUMERIC(12,2) NOT NULL DEFAULT 0,
  vat_amount    NUMERIC(12,2) NOT NULL DEFAULT 0,
  status        TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'issued', 'paid')),
  memo          TEXT,
  issued_at     TIMESTAMPTZ,
  paid_at       TIMESTAMPTZ,
  created_at    TIMESTAMPTZ DEFAULT now(),
  updated_at    TIMESTAMPTZ DEFAULT now(),
  UNIQUE (tenant_id, customer_id, period_month)
);

CREATE TABLE IF NOT EXISTS vat_batch_items (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id       UUID NOT NULL REFERENCES vat_batches(id) ON DELETE CASCADE,
  transaction_id UUID NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
  UNIQUE (batch_id, transaction_id)
);


-- ── 입고 ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS inbound_orders (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  inbound_date DATE NOT NULL DEFAULT CURRENT_DATE,
  supplier_id  UUID REFERENCES customers(id),
  memo         TEXT,
  total_amount NUMERIC(12,0) DEFAULT 0,
  created_at   TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS inbound_items (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  inbound_order_id UUID NOT NULL REFERENCES inbound_orders(id) ON DELETE CASCADE,
  variant_id       UUID NOT NULL REFERENCES product_variants(id),
  quantity         INTEGER NOT NULL DEFAULT 0,
  unit_price       NUMERIC(12,0) DEFAULT 0,
  created_at       TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS inbound_item_logs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  inbound_item_id UUID NOT NULL REFERENCES inbound_items(id) ON DELETE CASCADE,
  changed_field   TEXT NOT NULL,
  old_value       TEXT,
  new_value       TEXT,
  changed_at      TIMESTAMPTZ DEFAULT now()
);


-- ── 생산 ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS production_orders (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  order_id          UUID REFERENCES orders(id),
  production_number TEXT NOT NULL,
  factory           TEXT,
  status            TEXT DEFAULT 'planned' CHECK (status IN ('planned', 'in_progress', 'completed', 'cancelled')),
  planned_start_date DATE,
  planned_end_date   DATE,
  actual_end_date    DATE,
  memo               TEXT,
  created_at         TIMESTAMPTZ DEFAULT now(),
  updated_at         TIMESTAMPTZ DEFAULT now(),
  UNIQUE(tenant_id, production_number)
);

CREATE TABLE IF NOT EXISTS production_items (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  production_order_id UUID NOT NULL REFERENCES production_orders(id) ON DELETE CASCADE,
  variant_id          UUID NOT NULL REFERENCES product_variants(id),
  planned_quantity    INT NOT NULL,
  produced_quantity   INT DEFAULT 0,
  created_at          TIMESTAMPTZ DEFAULT now()
);


-- ── 배송 ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS shipments (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  order_id         UUID NOT NULL REFERENCES orders(id),
  carrier          TEXT,
  tracking_number  TEXT,
  status           TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'picked_up', 'in_transit', 'delivered', 'failed')),
  recipient_name   TEXT,
  recipient_phone  TEXT,
  recipient_address TEXT,
  shipped_at       TIMESTAMPTZ,
  delivered_at     TIMESTAMPTZ,
  created_at       TIMESTAMPTZ DEFAULT now()
);


-- ── 기타 ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS menu_configs (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  menu_key   TEXT NOT NULL,
  menu_label TEXT,
  is_visible BOOLEAN DEFAULT true,
  sort_order INT DEFAULT 0,
  UNIQUE(tenant_id, menu_key)
);

CREATE TABLE IF NOT EXISTS api_keys (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  key_hash     TEXT UNIQUE NOT NULL,
  permissions  JSONB DEFAULT '[]',
  last_used_at TIMESTAMPTZ,
  expires_at   TIMESTAMPTZ,
  is_active    BOOLEAN DEFAULT true,
  created_at   TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS notifications (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id    UUID REFERENCES users(id),
  type       TEXT NOT NULL,
  channel    TEXT,
  title      TEXT,
  message    TEXT,
  is_read    BOOLEAN DEFAULT false,
  sent_at    TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now()
);


-- ── RLS 비활성화 (개발 중) ────────────────────
ALTER TABLE subscription_plans     DISABLE ROW LEVEL SECURITY;
ALTER TABLE tenants                DISABLE ROW LEVEL SECURITY;
ALTER TABLE users                  DISABLE ROW LEVEL SECURITY;
ALTER TABLE roles                  DISABLE ROW LEVEL SECURITY;
ALTER TABLE permissions            DISABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_connections     DISABLE ROW LEVEL SECURITY;
ALTER TABLE product_categories     DISABLE ROW LEVEL SECURITY;
ALTER TABLE products               DISABLE ROW LEVEL SECURITY;
ALTER TABLE product_images         DISABLE ROW LEVEL SECURITY;
ALTER TABLE product_variants       DISABLE ROW LEVEL SECURITY;
ALTER TABLE product_measurements   DISABLE ROW LEVEL SECURITY;
ALTER TABLE product_customer_prices DISABLE ROW LEVEL SECURITY;
ALTER TABLE product_mappings       DISABLE ROW LEVEL SECURITY;
ALTER TABLE customers              DISABLE ROW LEVEL SECURITY;
ALTER TABLE inventory              DISABLE ROW LEVEL SECURITY;
ALTER TABLE orders                 DISABLE ROW LEVEL SECURITY;
ALTER TABLE order_items            DISABLE ROW LEVEL SECURITY;
ALTER TABLE transactions           DISABLE ROW LEVEL SECURITY;
ALTER TABLE inbound_orders         DISABLE ROW LEVEL SECURITY;
ALTER TABLE inbound_items          DISABLE ROW LEVEL SECURITY;
ALTER TABLE inbound_item_logs      DISABLE ROW LEVEL SECURITY;
ALTER TABLE production_orders      DISABLE ROW LEVEL SECURITY;
ALTER TABLE production_items       DISABLE ROW LEVEL SECURITY;
ALTER TABLE shipments              DISABLE ROW LEVEL SECURITY;
ALTER TABLE menu_configs           DISABLE ROW LEVEL SECURITY;
ALTER TABLE api_keys               DISABLE ROW LEVEL SECURITY;
ALTER TABLE notifications          DISABLE ROW LEVEL SECURITY;


-- ── 인덱스 ───────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_users_tenant           ON users(tenant_id);
CREATE INDEX IF NOT EXISTS idx_products_tenant        ON products(tenant_id);
CREATE INDEX IF NOT EXISTS idx_customers_tenant       ON customers(tenant_id);
CREATE INDEX IF NOT EXISTS idx_orders_tenant          ON orders(tenant_id);
CREATE INDEX IF NOT EXISTS idx_orders_customer        ON orders(customer_id);
CREATE INDEX IF NOT EXISTS idx_order_items_order      ON order_items(order_id);
CREATE INDEX IF NOT EXISTS idx_inventory_tenant       ON inventory(tenant_id);
CREATE INDEX IF NOT EXISTS idx_transactions_tenant        ON transactions(tenant_id);
CREATE INDEX IF NOT EXISTS idx_transactions_cash_session  ON transactions(cash_session_id);
CREATE INDEX IF NOT EXISTS idx_cash_sessions_tenant_date  ON cash_sessions(tenant_id, session_date DESC);
CREATE INDEX IF NOT EXISTS idx_inbound_orders_tenant      ON inbound_orders(tenant_id);
CREATE INDEX IF NOT EXISTS idx_notifications_user     ON notifications(user_id);


-- ── 기본 데이터 ──────────────────────────────
INSERT INTO subscription_plans (name, description, price, billing_cycle, features, sort_order)
VALUES ('Basic', '도매 POS 기본 플랜', 99000, 'monthly',
  '["판매관리", "거래처관리", "상품관리", "재고관리"]'::jsonb, 1)
ON CONFLICT DO NOTHING;
