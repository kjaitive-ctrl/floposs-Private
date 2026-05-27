-- =============================================
-- RETAIL SITE — 플랫폼 & 모델
-- =============================================

-- 플랫폼 (네이버, 쿠팡, 무신사 등)
CREATE TABLE IF NOT EXISTS retail_platforms (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  retailer_id UUID NOT NULL REFERENCES retail_retailers(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  fee_rate NUMERIC(5,2),        -- 수수료율 (%) — 나중에 정산 계산용
  memo TEXT,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(retailer_id, name)
);

CREATE INDEX IF NOT EXISTS idx_platforms_retailer ON retail_platforms(retailer_id);

-- retail_003에서 retail_platforms가 없어서 실패했을 경우 재생성
CREATE TABLE IF NOT EXISTS retail_platform_listings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id UUID NOT NULL REFERENCES retail_products(id) ON DELETE CASCADE,
  platform_id UUID NOT NULL REFERENCES retail_platforms(id) ON DELETE CASCADE,
  is_uploaded BOOLEAN DEFAULT false,
  uploaded_at TIMESTAMPTZ,
  memo TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(product_id, platform_id)
);

CREATE INDEX IF NOT EXISTS idx_platform_listings_product ON retail_platform_listings(product_id);
CREATE INDEX IF NOT EXISTS idx_platform_listings_platform ON retail_platform_listings(platform_id);

-- 모델 (retail_003에 이미 있지만 IF NOT EXISTS로 안전하게)
CREATE TABLE IF NOT EXISTS retail_models (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  retailer_id UUID NOT NULL REFERENCES retail_retailers(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  memo TEXT,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_models_retailer ON retail_models(retailer_id);

-- 개발용 기본 플랫폼 데이터 (DEV_RETAILER_ID 기준)
INSERT INTO retail_platforms (retailer_id, name, fee_rate) VALUES
  ('d4cdcd56-e47b-487f-8ace-d84654dec489', '네이버 스마트스토어', 5.85),
  ('d4cdcd56-e47b-487f-8ace-d84654dec489', '쿠팡', 10.80),
  ('d4cdcd56-e47b-487f-8ace-d84654dec489', '무신사', 20.00),
  ('d4cdcd56-e47b-487f-8ace-d84654dec489', '에이블리', 15.00),
  ('d4cdcd56-e47b-487f-8ace-d84654dec489', '지그재그', 15.00),
  ('d4cdcd56-e47b-487f-8ace-d84654dec489', '자사몰', 0.00)
ON CONFLICT (retailer_id, name) DO NOTHING;
