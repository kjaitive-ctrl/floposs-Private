// @supabase/ssr 의 createBrowserClient — 쿠키에 세션 저장 → middleware/server 에서 읽음.
// admin app 전용 cookie (sb-admin-auth) — wholesale/retail 과 분리 →
// super_admin 이 admin 사이트에서 별도 로그인 (다른 도메인 + 다른 cookie).
import { createBrowserClient } from "@supabase/ssr";

export const supabase = createBrowserClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  { cookieOptions: { name: "sb-admin-auth" } }
);
