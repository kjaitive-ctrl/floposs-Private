-- 구독 플랜 테이블
CREATE TABLE IF NOT EXISTS subscription_plans (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  description TEXT,
  price NUMERIC(10,2) NOT NULL DEFAULT 0,
  billing_cycle TEXT NOT NULL DEFAULT 'monthly', -- 'monthly', 'yearly', 'one_time'
  features JSONB NOT NULL DEFAULT '[]',
  is_active BOOLEAN NOT NULL DEFAULT true,
  sort_order INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now()
);
ALTER TABLE subscription_plans DISABLE ROW LEVEL SECURITY;

-- tenants 테이블 확장 (사업자 정보 + 분류 + 플랜 연결)
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS business_number TEXT;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS owner_name TEXT;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS phone TEXT;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS address TEXT;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS category TEXT NOT NULL DEFAULT 'wholesale';
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS admin_note TEXT;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS plan_id UUID REFERENCES subscription_plans(id);
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS subscription_expires_at TIMESTAMPTZ;

-- 기본 플랜 삽입
INSERT INTO subscription_plans (name, description, price, billing_cycle, features, sort_order)
VALUES (
  'Basic',
  '도매 POS 기본 플랜',
  99000,
  'monthly',
  '["판매관리", "거래처관리", "상품관리", "재고관리", "재고관리"]'::jsonb,
  1
) ON CONFLICT DO NOTHING;
