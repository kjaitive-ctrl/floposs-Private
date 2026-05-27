// @supabase/ssr 의 createBrowserClient — 쿠키에 세션 저장 → proxy/server route 에서 읽음.
// wholesale-pos/lib/supabase.ts 와 동일 패턴 + cookieOptions.name='sb-retail-auth' 로 분리.
// wholesale (3000) 와 cookie share 막아서 두 vertical 동시 로그인 가능.
import { createBrowserClient } from "@supabase/ssr";

export const supabase = createBrowserClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  { cookieOptions: { name: "sb-retail-auth" } }
);
