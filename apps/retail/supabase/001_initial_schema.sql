-- =============================================
-- RETAIL SITE — 초기 스키마
-- =============================================

-- 1. RETAILERS (소매업체 — wholesale의 tenants에 해당)
CREATE TABLE retailers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,                        -- 업체명
  business_number TEXT,                      -- 사업자번호
  owner_name TEXT,
  phone TEXT,
  email TEXT UNIQUE,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- 2. PRODUCTS (상품 마스터)
CREATE TABLE products (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  retailer_id UUID NOT NULL REFERENCES retailers(id) ON DELETE CASCADE,
  name TEXT NOT NULL,                        -- 상품명
  product_code TEXT,                         -- 상품코드
  category TEXT,
  base_price NUMERIC(12, 2) NOT NULL DEFAULT 0,
  description TEXT,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(retailer_id, product_code)
);

-- 3. PRODUCT VARIANTS (SKU 단위 — 색상+사이즈 조합 하나하나가 UUID)
CREATE TABLE product_variants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  color TEXT,                                -- 색상 (레드, 블루 등)
  size TEXT,                                 -- 사이즈 (S, M, L, F 등)
  sku TEXT,                                  -- 자체 SKU 코드
  barcode TEXT,
  additional_price NUMERIC(12, 2) DEFAULT 0,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(product_id, color, size)
);

-- 4. INVENTORY (재고 — variant 단위)
CREATE TABLE inventory (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  retailer_id UUID NOT NULL REFERENCES retailers(id) ON DELETE CASCADE,
  variant_id UUID NOT NULL REFERENCES product_variants(id) ON DELETE CASCADE,
  quantity INT NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(retailer_id, variant_id)
);

-- =============================================
-- 인덱스
-- =============================================
CREATE INDEX idx_products_retailer ON products(retailer_id);
CREATE INDEX idx_variants_product ON product_variants(product_id);
CREATE INDEX idx_inventory_retailer ON inventory(retailer_id);
CREATE INDEX idx_inventory_variant ON inventory(variant_id);
