// @supabase/ssr 의 createBrowserClient — 쿠키에 세션 저장 → middleware/server 에서 읽음
// supabase-js 의 createClient (localStorage 전용) 와 호환되는 인터페이스
//
// cookieOptions.name 분리 (2026-05-15): retail-site (3001) 와 같은 Supabase project 라
// 기본 cookie 이름이 동일 → localhost 에서 cookie share → 두 vertical 동시 로그인 불가.
// vertical 별 prefix 로 분리해서 dev/운영 모두 인증 독립.
import { createBrowserClient } from "@supabase/ssr";

export const supabase = createBrowserClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  { cookieOptions: { name: "sb-wholesale-auth" } }
);
