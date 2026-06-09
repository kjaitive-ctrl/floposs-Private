import { redirect } from "next/navigation";
import { getSupabaseRouteClient } from "@/lib/supabase-server";

// 루트 진입 — 서버에서 세션 먼저 확인 후 분기 (samples 셸 깜빡임 방지).
//   로그인됨 → /samples (메인)  /  미로그인 → /login (바로)
export default async function Home() {
  const supabase = await getSupabaseRouteClient();
  const { data: { user } } = await supabase.auth.getUser();
  redirect(user ? "/samples" : "/login");
}
