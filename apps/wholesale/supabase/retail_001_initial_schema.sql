-- =============================================
-- RETAIL SITE — 소매 전용 테이블
-- wholesale-pos Supabase에 함께 존재
-- =============================================

-- 1. RETAIL_RETAILERS (소매업체)
CREATE TABLE retail_retailers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  business_number TEXT,
  owner_name TEXT,
  phone TEXT,
  email TEXT UNIQUE,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- 2. RETAIL_PRODUCTS (소매 상품 마스터)
CREATE TABLE retail_products (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  retailer_id UUID NOT NULL REFERENCES retail_retailers(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  product_code TEXT,
  category TEXT,
  base_price NUMERIC(12, 2) NOT NULL DEFAULT 0,
  description TEXT,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(retailer_id, product_code)
);

-- 3. RETAIL_PRODUCT_VARIANTS (소매 SKU — 색상+사이즈 조합 하나하나가 UUID)
CREATE TABLE retail_product_variants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id UUID NOT NULL REFERENCES retail_products(id) ON DELETE CASCADE,
  color TEXT,
  size TEXT,
  sku TEXT,
  barcode TEXT,
  additional_price NUMERIC(12, 2) DEFAULT 0,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(product_id, color, size)
);

-- 4. RETAIL_INVENTORY (소매 재고 — variant 단위)
CREATE TABLE retail_inventory (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  retailer_id UUID NOT NULL REFERENCES retail_retailers(id) ON DELETE CASCADE,
  variant_id UUID NOT NULL REFERENCES retail_product_variants(id) ON DELETE CASCADE,
  quantity INT NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(retailer_id, variant_id)
);

-- =============================================
-- 인덱스
-- =============================================
CREATE INDEX idx_retail_products_retailer ON retail_products(retailer_id);
CREATE INDEX idx_retail_variants_product ON retail_product_variants(product_id);
CREATE INDEX idx_retail_inventory_retailer ON retail_inventory(retailer_id);
CREATE INDEX idx_retail_inventory_variant ON retail_inventory(variant_id);
