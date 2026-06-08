import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-admin";

// A/S — super_admin 이 retail 매장 계정으로 진입할 magiclink 토큰 발급. [[project_logi_axis 인접: A/S]]
// 비번 변경 X: generateLink(magiclink) → token_hash 반환 → retail /impersonate 에서 verifyOtp.
// 진입 시점 impersonation_logs 박제(마이그 211). 쓰기 허용 범위(사장 결정) + retail 상시 배너로 보완.
export async function POST(req: NextRequest) {
  // 요청자 super_admin 검증
  const token = req.headers.get("authorization")?.replace("Bearer ", "");
  if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { data: { user: caller } } = await supabaseAdmin.auth.getUser(token);
  if ((caller?.app_metadata as { role?: string } | undefined)?.role !== "super_admin") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { tenant_id, email, reason } = await req.json();
  if (!tenant_id || !email) {
    return NextResponse.json({ error: "tenant_id, email 누락" }, { status: 400 });
  }

  // 대상이 실제 retail tenant 인지 확인 (오남용 방지)
  const { data: target } = await supabaseAdmin
    .from("tenants")
    .select("id, tenant_type")
    .eq("id", tenant_id)
    .maybeSingle();
  if (!target || target.tenant_type !== "retail") {
    return NextResponse.json({ error: "retail 매장이 아닙니다." }, { status: 400 });
  }

  // magiclink 토큰 발급 (비번 미변경)
  const { data, error } = await supabaseAdmin.auth.admin.generateLink({
    type: "magiclink",
    email: String(email),
  });
  if (error || !data.properties?.hashed_token) {
    return NextResponse.json({ error: error?.message ?? "토큰 발급 실패" }, { status: 400 });
  }

  // 진입 감사로그 박제
  await supabaseAdmin.from("impersonation_logs").insert({
    admin_user_id: caller!.id,
    admin_email: caller!.email,
    target_tenant_id: tenant_id,
    target_email: String(email),
    reason: reason || null,
  });

  return NextResponse.json({ token_hash: data.properties.hashed_token });
}
