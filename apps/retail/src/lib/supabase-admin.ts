// service_role 키로 server-only 작업 (Supabase Auth admin / cross-tenant INSERT 등).
// 절대 client bundle 으로 새 나가지 않게 — server route 에서만 import.
// wholesale-pos/lib/supabase-admin.ts 와 동일 패턴.
import { createClient } from "@supabase/supabase-js";

export const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { autoRefreshToken: false, persistSession: false } }
);
