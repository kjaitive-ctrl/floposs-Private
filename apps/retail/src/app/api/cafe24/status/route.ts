import { NextResponse } from "next/server";
import { getSupabaseRouteClient } from "@/lib/supabase-server";
import { supabaseAdmin } from "@/lib/supabase-admin";

// 카페24 연동 상태 확인. 서버에서 admin 클라이언트로 tenant_cafe24_tokens 조회.
// tenant_cafe24_tokens 는 RLS 정책 없음 → 브라우저 직접 접근 불가.
export async function GET() {
  const supabase = await getSupabaseRouteClient();
  const { data: { user } } = await supabase.auth.getUser();
  const tenantId = (user?.app_metadata as { tenant_id?: string } | undefined)?.tenant_id;
  if (!tenantId) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });

  const { data } = await supabaseAdmin
    .from("tenant_cafe24_tokens")
    .select("mall_id, expires_at, updated_at")
    .eq("retail_tenant_id", tenantId)
    .maybeSingle();

  if (!data) return NextResponse.json({ connected: false, mall_id: null });

  return NextResponse.json({
    connected: true,
    mall_id: data.mall_id,
    expires_at: data.expires_at,
    updated_at: data.updated_at,
  });
}
