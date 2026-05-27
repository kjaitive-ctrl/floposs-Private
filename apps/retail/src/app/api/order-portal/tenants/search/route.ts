import { NextRequest, NextResponse } from "next/server";
import { getSupabaseRouteClient } from "@/lib/supabase-server";
import { supabaseAdmin } from "@/lib/supabase-admin";

// wholesale tenants 검색. 매장명/주소/연락처 LIKE.
// 본인이 retail 인증된 상태에서만 호출 가능.
export async function GET(req: NextRequest) {
  const supabase = await getSupabaseRouteClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }

  const q = (req.nextUrl.searchParams.get("q") ?? "").trim();

  let query = supabaseAdmin
    .from("tenants")
    .select("id, company_name, owner_name, phone, address")
    .eq("tenant_type", "wholesale")
    .eq("is_active", true)
    .order("company_name", { ascending: true })
    .limit(50);

  if (q) {
    const like = `%${q}%`;
    query = query.or(
      `company_name.ilike.${like},owner_name.ilike.${like},phone.ilike.${like},address.ilike.${like}`
    );
  }

  const { data, error } = await query;
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ tenants: data ?? [] });
}
