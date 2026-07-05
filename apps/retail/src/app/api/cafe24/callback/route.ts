import { NextRequest, NextResponse } from "next/server";
import { getSupabaseRouteClient } from "@/lib/supabase-server";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { exchangeCodeForToken } from "@/lib/cafe24";

// 카페24 OAuth 콜백. code + state 수신 → CSRF 검증 → 토큰 교환 → tenant_cafe24_tokens 박제.
// tenant_id 는 같은 브라우저 세션(쿠키)에서 복원. mall_id 는 authorize 때 심은 쿠키.
export async function GET(req: NextRequest) {
  const origin = req.nextUrl.origin;
  const code = req.nextUrl.searchParams.get("code");
  const state = req.nextUrl.searchParams.get("state");
  const cookieState = req.cookies.get("cafe24_state")?.value;
  const mallId = req.cookies.get("cafe24_mall")?.value;

  if (!code || !state || !cookieState || state !== cookieState || !mallId) {
    return NextResponse.redirect(`${origin}/dashboard/settings?cafe24=error`);
  }

  const supabase = await getSupabaseRouteClient();
  const { data: { user } } = await supabase.auth.getUser();
  const tenantId = (user?.app_metadata as { tenant_id?: string } | undefined)?.tenant_id;
  if (!tenantId) return NextResponse.redirect(`${origin}/login`);

  try {
    const t = await exchangeCodeForToken(mallId, code);
    await supabaseAdmin.from("tenant_cafe24_tokens").upsert({
      retail_tenant_id: tenantId,
      mall_id: mallId,
      access_token: t.access_token,
      refresh_token: t.refresh_token,
      expires_at: t.expires_at,
      refresh_expires_at: t.refresh_token_expires_at ?? null,
      scope: (t.scopes ?? []).join(","),
      updated_at: new Date().toISOString(),
    }, { onConflict: "retail_tenant_id" });
  } catch (e) {
    console.error("cafe24 callback:", e);
    return NextResponse.redirect(`${origin}/dashboard/settings?cafe24=error`);
  }

  const res = NextResponse.redirect(`${origin}/dashboard/settings?cafe24=connected`);
  res.cookies.delete("cafe24_state");
  res.cookies.delete("cafe24_mall");
  return res;
}
