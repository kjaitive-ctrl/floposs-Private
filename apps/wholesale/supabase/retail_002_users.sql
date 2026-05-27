-- RETAIL_USERS (소매업체 사용자 — wholesale의 users에 해당)
CREATE TABLE retail_users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  retailer_id UUID NOT NULL REFERENCES retail_retailers(id) ON DELETE CASCADE,
  auth_user_id UUID NOT NULL UNIQUE,  -- Supabase auth.users.id
  email TEXT NOT NULL,
  name TEXT,
  role TEXT NOT NULL DEFAULT 'retailer_admin',
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_retail_users_retailer ON retail_users(retailer_id);
CREATE INDEX idx_retail_users_auth ON retail_users(auth_user_id);
