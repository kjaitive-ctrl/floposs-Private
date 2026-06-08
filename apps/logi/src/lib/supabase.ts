// @supabase/ssr browser client — 쿠키 'sb-logi-auth' 로 분리.
// retail(sb-retail-auth)/wholesale(sb-wholesale-auth) 와 cookie 충돌 방지 → 동시 로그인 가능.
// logi 는 RLS 비활성 단계라 browser-direct 쿼리 [[feedback_retail_browser_supabase_direct]].
import { createBrowserClient } from "@supabase/ssr";

export const supabase = createBrowserClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  { cookieOptions: { name: "sb-logi-auth" } }
);
