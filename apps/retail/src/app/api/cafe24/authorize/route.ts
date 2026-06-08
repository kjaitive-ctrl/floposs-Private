import { NextRequest, NextResponse } from "next/server";
import { getSupabaseRouteClient } from "@/lib/supabase-server";
import { buildAuthorizeUrl } from "@/lib/cafe24";

// 카페24 OAuth 시작. retail tenant 로그인 상태 + mall_id(쿼리) → 인증 페이지로 redirect.
// state/mall_id 는 httpOnly 쿠키로 캐리 (callback 에서 CSRF 검증 + mall_id 복원).
export async function GET(req: NextRequest) {
  const supabase = await getSupabaseRouteClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });

  const mallId = (req.nextUrl.searchParams.get("mall_id") ?? "").trim();
  if (!mallId) return NextResponse.json({ error: "mall_id 가 필요합니다." }, { status: 400 });

  const state = crypto.randomUUID();
  const res = NextResponse.redirect(buildAuthorizeUrl(mallId, state));
  const opts = { httpOnly: true, secure: true, sameSite: "lax" as const, maxAge: 600, path: "/" };
  res.cookies.set("cafe24_state", state, opts);
  res.cookies.set("cafe24_mall", mallId, opts);
  return res;
}
