// 도매 보드(/s) 전용 Supabase 브라우저 클라이언트 — 쿠키 'sb-board-auth' 로 격리.
// retail(sb-retail-auth)/wholesale(sb-wholesale-auth) 세션과 충돌 방지.
// 보드계정 = slot-<public_code>@board.floposs.local (slot별, admin이 클레임 시 생성).
import { createBrowserClient } from "@supabase/ssr";

export const supabaseBoard = createBrowserClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  { cookieOptions: { name: "sb-board-auth" } }
);

// public_code → 보드계정 이메일 (deterministic).
export function boardEmail(code: string): string {
  return `slot-${code}@board.floposs.local`;
}
