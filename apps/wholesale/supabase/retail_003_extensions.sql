-- =============================================
-- RETAIL SITE — 확장 스키마
-- =============================================

-- retail_products 필드 추가
ALTER TABLE retail_products
  ADD COLUMN season TEXT,
  ADD COLUMN status TEXT DEFAULT 'sample_received'
    CHECK (status IN ('sample_received', 'shooting_done', 'registered', 'returned', 'inactive'));

-- 모델
CREATE TABLE retail_models (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  retailer_id UUID NOT NULL REFERENCES retail_retailers(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  memo TEXT,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- 촬영 세션 (한 번 나갈 때 수십 옵션 묶음)
CREATE TABLE retail_shoots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  retailer_id UUID NOT NULL REFERENCES retail_retailers(id) ON DELETE CASCADE,
  shoot_date DATE NOT NULL,
  model_id UUID REFERENCES retail_models(id),
  memo TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- 촬영 항목 (상품+옵션+코디 기록)
CREATE TABLE retail_shoot_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  shoot_id UUID NOT NULL REFERENCES retail_shoots(id) ON DELETE CASCADE,
  product_id UUID NOT NULL REFERENCES retail_products(id) ON DELETE CASCADE,
  variant_id UUID REFERENCES retail_product_variants(id),
  styling_note TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- 플랫폼 업로드 체크
CREATE TABLE retail_platform_listings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id UUID NOT NULL REFERENCES retail_products(id) ON DELETE CASCADE,
  platform_id UUID NOT NULL REFERENCES retail_platforms(id) ON DELETE CASCADE,
  is_uploaded BOOLEAN DEFAULT false,
  uploaded_at TIMESTAMPTZ,
  memo TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(product_id, platform_id)
);

-- 주문서 (구조만 — 구현은 나중에)
CREATE TABLE retail_orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  retailer_id UUID NOT NULL REFERENCES retail_retailers(id) ON DELETE CASCADE,
  season TEXT,
  status TEXT DEFAULT 'draft',
  wholesale_tenant_id UUID,
  memo TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- 주문 항목
CREATE TABLE retail_order_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id UUID NOT NULL REFERENCES retail_orders(id) ON DELETE CASCADE,
  product_id UUID NOT NULL REFERENCES retail_products(id),
  variant_id UUID REFERENCES retail_product_variants(id),
  quantity INT DEFAULT 0,
  unit_price NUMERIC(12,2),
  created_at TIMESTAMPTZ DEFAULT now()
);

-- 사입삼촌 픽업 요청 (도매 정보 기반)
CREATE TABLE retail_logistics_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  retailer_id UUID NOT NULL REFERENCES retail_retailers(id) ON DELETE CASCADE,
  wholesale_tenant_id UUID,
  pickup_date DATE,
  status TEXT DEFAULT 'pending'
    CHECK (status IN ('pending', 'confirmed', 'completed', 'cancelled')),
  memo TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- 인덱스
CREATE INDEX idx_shoots_retailer ON retail_shoots(retailer_id);
CREATE INDEX idx_shoot_items_shoot ON retail_shoot_items(shoot_id);
CREATE INDEX idx_shoot_items_product ON retail_shoot_items(product_id);
CREATE INDEX idx_platform_listings_product ON retail_platform_listings(product_id);
CREATE INDEX idx_orders_retailer ON retail_orders(retailer_id);
CREATE INDEX idx_order_items_order ON retail_order_items(order_id);
