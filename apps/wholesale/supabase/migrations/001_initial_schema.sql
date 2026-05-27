-- =============================================
-- WHOLESALE POS - 전체 DB 스키마
-- =============================================

-- 1. TENANTS (플랫폼 가입 업체 전체)
CREATE TABLE tenants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_type TEXT NOT NULL CHECK (tenant_type IN ('wholesale', 'retail', 'logistics')),
  company_name TEXT NOT NULL,
  business_number TEXT UNIQUE,
  owner_name TEXT,
  phone TEXT,
  address TEXT,
  subscription_plan TEXT DEFAULT 'basic' CHECK (subscription_plan IN ('basic', 'pro', 'enterprise')),
  subscription_status TEXT DEFAULT 'active' CHECK (subscription_status IN ('active', 'suspended', 'cancelled')),
  subscription_expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- 2. USERS (직원/계정)
CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  email TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  phone TEXT,
  role TEXT NOT NULL DEFAULT 'staff' CHECK (role IN ('super_admin', 'tenant_admin', 'manager', 'staff')),
  is_active BOOLEAN DEFAULT true,
  last_login_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- 3. ROLES (역할 - 업체별 커스텀 역할)
CREATE TABLE roles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- 4. PERMISSIONS (메뉴별 권한)
CREATE TABLE permissions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  role_id UUID NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  menu_key TEXT NOT NULL,
  can_view BOOLEAN DEFAULT false,
  can_create BOOLEAN DEFAULT false,
  can_edit BOOLEAN DEFAULT false,
  can_delete BOOLEAN DEFAULT false
);

-- 5. TENANT CONNECTIONS (도매↔소매 연결)
CREATE TABLE tenant_connections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  wholesale_tenant_id UUID NOT NULL REFERENCES tenants(id),
  retail_tenant_id UUID NOT NULL REFERENCES tenants(id),
  status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'active', 'suspended')),
  connected_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- 6. PRODUCTS (상품 기본정보)
CREATE TABLE products (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  product_code TEXT,
  category TEXT,
  description TEXT,
  base_price NUMERIC(12, 2) NOT NULL DEFAULT 0,
  material_composition JSONB DEFAULT '{}',  -- {"면": 70, "폴리": 30}
  manufacturer TEXT,
  designer TEXT,
  fabric_source TEXT,
  country_of_origin TEXT,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(tenant_id, product_code)
);

-- 7. PRODUCT IMAGES (상품 사진)
CREATE TABLE product_images (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  sort_order INT DEFAULT 0,
  is_main BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- 8. PRODUCT VARIANTS (색상+사이즈 조합)
CREATE TABLE product_variants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  color TEXT,
  size TEXT,
  sku TEXT,
  barcode TEXT,
  additional_price NUMERIC(12, 2) DEFAULT 0,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(product_id, color, size)
);

-- 9. PRODUCT MEASUREMENTS (사이즈별 치수)
CREATE TABLE product_measurements (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  size TEXT NOT NULL,
  measurements JSONB DEFAULT '{}',  -- {"허리": 72, "허벅지": 54, "힙": 92}
  UNIQUE(product_id, size)
);

-- 10. CUSTOMERS (거래처)
CREATE TABLE customers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  linked_tenant_id UUID REFERENCES tenants(id),  -- 플랫폼 내 소매업체와 연동 시
  company_name TEXT NOT NULL,
  business_number TEXT,
  owner_name TEXT,
  phone TEXT,
  email TEXT,
  address TEXT,
  credit_limit NUMERIC(12, 2) DEFAULT 0,
  outstanding_balance NUMERIC(12, 2) DEFAULT 0,
  memo TEXT,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- 11. PRODUCT CUSTOMER PRICES (거래처별 네고 단가)
CREATE TABLE product_customer_prices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  product_id UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  variant_id UUID REFERENCES product_variants(id),
  negotiated_price NUMERIC(12, 2) NOT NULL,
  valid_from DATE,
  valid_until DATE,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- 12. PRODUCT MAPPINGS (외부 시스템 SKU 매핑)
CREATE TABLE product_mappings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  variant_id UUID NOT NULL REFERENCES product_variants(id) ON DELETE CASCADE,
  external_system TEXT NOT NULL,  -- 'erp', 'retail', 'logistics', 'smartstore'
  external_tenant_id UUID REFERENCES tenants(id),
  external_sku TEXT,
  external_barcode TEXT,
  external_product_name TEXT,
  external_option TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(variant_id, external_system, external_tenant_id)
);

-- 13. INVENTORY (재고)
CREATE TABLE inventory (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  variant_id UUID NOT NULL REFERENCES product_variants(id) ON DELETE CASCADE,
  quantity INT NOT NULL DEFAULT 0,
  location TEXT,
  updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(tenant_id, variant_id)
);

-- 14. ORDERS (주문)
CREATE TABLE orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  customer_id UUID NOT NULL REFERENCES customers(id),
  order_number TEXT NOT NULL,
  order_type TEXT DEFAULT 'wholesale' CHECK (order_type IN ('wholesale', 'bulk', 'retail_b2b')),
  status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'confirmed', 'in_production', 'ready', 'shipped', 'delivered', 'cancelled')),
  total_amount NUMERIC(12, 2) DEFAULT 0,
  paid_amount NUMERIC(12, 2) DEFAULT 0,
  outstanding_amount NUMERIC(12, 2) DEFAULT 0,
  expected_delivery_date DATE,
  memo TEXT,
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(tenant_id, order_number)
);

-- 15. ORDER ITEMS (주문 상세)
CREATE TABLE order_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  variant_id UUID NOT NULL REFERENCES product_variants(id),
  quantity INT NOT NULL,
  unit_price NUMERIC(12, 2) NOT NULL,
  total_price NUMERIC(12, 2) NOT NULL,
  status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'in_production', 'ready', 'shipped', 'delivered')),
  created_at TIMESTAMPTZ DEFAULT now()
);

-- 16. TRANSACTIONS (입출금)
CREATE TABLE transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  customer_id UUID REFERENCES customers(id),
  order_id UUID REFERENCES orders(id),
  type TEXT NOT NULL CHECK (type IN ('income', 'expense', 'receivable', 'payable')),
  amount NUMERIC(12, 2) NOT NULL,
  method TEXT CHECK (method IN ('cash', 'transfer', 'card', 'other')),
  description TEXT,
  transaction_date DATE NOT NULL,
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ DEFAULT now()
);

-- 17. PRODUCTION ORDERS (생산 관리)
CREATE TABLE production_orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  order_id UUID REFERENCES orders(id),
  production_number TEXT NOT NULL,
  factory TEXT,
  status TEXT DEFAULT 'planned' CHECK (status IN ('planned', 'in_progress', 'completed', 'cancelled')),
  planned_start_date DATE,
  planned_end_date DATE,
  actual_end_date DATE,
  memo TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(tenant_id, production_number)
);

-- 18. PRODUCTION ITEMS (생산 상세)
CREATE TABLE production_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  production_order_id UUID NOT NULL REFERENCES production_orders(id) ON DELETE CASCADE,
  variant_id UUID NOT NULL REFERENCES product_variants(id),
  planned_quantity INT NOT NULL,
  produced_quantity INT DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- 19. SHIPMENTS (배송/송장)
CREATE TABLE shipments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  order_id UUID NOT NULL REFERENCES orders(id),
  carrier TEXT,  -- 'CJ', 'HANJIN', 'LOGEN', 'EPOST'
  tracking_number TEXT,
  status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'picked_up', 'in_transit', 'delivered', 'failed')),
  recipient_name TEXT,
  recipient_phone TEXT,
  recipient_address TEXT,
  shipped_at TIMESTAMPTZ,
  delivered_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- 20. MENU CONFIGS (메뉴 커스터마이징)
CREATE TABLE menu_configs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  menu_key TEXT NOT NULL,
  menu_label TEXT,
  is_visible BOOLEAN DEFAULT true,
  sort_order INT DEFAULT 0,
  UNIQUE(tenant_id, menu_key)
);

-- 21. API KEYS (외부 연동용 API 키)
CREATE TABLE api_keys (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  key_hash TEXT UNIQUE NOT NULL,
  permissions JSONB DEFAULT '[]',
  last_used_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- 22. NOTIFICATIONS (알림 로그)
CREATE TABLE notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id UUID REFERENCES users(id),
  type TEXT NOT NULL,  -- 'order', 'payment', 'inventory', 'system'
  channel TEXT,  -- 'kakao', 'wechat', 'email', 'sms'
  title TEXT,
  message TEXT,
  is_read BOOLEAN DEFAULT false,
  sent_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- =============================================
-- 인덱스 (성능 최적화)
-- =============================================
CREATE INDEX idx_users_tenant ON users(tenant_id);
CREATE INDEX idx_products_tenant ON products(tenant_id);
CREATE INDEX idx_customers_tenant ON customers(tenant_id);
CREATE INDEX idx_orders_tenant ON orders(tenant_id);
CREATE INDEX idx_orders_customer ON orders(customer_id);
CREATE INDEX idx_order_items_order ON order_items(order_id);
CREATE INDEX idx_inventory_tenant ON inventory(tenant_id);
CREATE INDEX idx_transactions_tenant ON transactions(tenant_id);
CREATE INDEX idx_notifications_user ON notifications(user_id);
