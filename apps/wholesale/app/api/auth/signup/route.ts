import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-admin";

// 도매 가입: tenant + 사장 계정(tenant_admin) 1세트 생성
export async function POST(req: NextRequest) {
  const { email, password, company_name } = await req.json();

  if (!email || !password || !company_name)
    return NextResponse.json({ error: "필수 항목이 누락되었습니다." }, { status: 400 });

  // 1) Auth 계정 생성 (tenant_id 는 tenant 만든 후 update)
  const { data: authData, error: authError } = await supabaseAdmin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    app_metadata: { role: "tenant_admin", user_type: "wholesale" },
  });
  if (authError) {
    const msg = authError.message.includes("already registered") || authError.message.includes("already been registered")
      ? "이미 등록된 이메일입니다."
      : authError.message;
    return NextResponse.json({ error: msg }, { status: 400 });
  }

  // 2) tenant 생성 (status='pending' — admin 승인 대기)
  const { data: tenant, error: tenantError } = await supabaseAdmin
    .from("tenants")
    .insert({
      tenant_type: "wholesale",
      company_name,
      is_active: false,    // status='pending' 과 일관성 (legacy 컬럼)
      status: "pending",   // admin 승인 후 'active'
    })
    .select("id")
    .single();

  if (tenantError) {
    await supabaseAdmin.auth.admin.deleteUser(authData.user.id);
    return NextResponse.json({ error: tenantError.message }, { status: 400 });
  }

  // 3) public.users 생성
  const { error: userError } = await supabaseAdmin.from("users").insert({
    tenant_id: tenant.id,
    email,
    name: company_name,
    role: "tenant_admin",
    user_type: "wholesale",
  });

  if (userError) {
    await supabaseAdmin.auth.admin.deleteUser(authData.user.id);
    await supabaseAdmin.from("tenants").delete().eq("id", tenant.id);
    return NextResponse.json({ error: userError.message }, { status: 400 });
  }

  // 4) tenant_id 를 app_metadata 에 박기 (JWT claim 으로 자동 포함)
  const { error: metaError } = await supabaseAdmin.auth.admin.updateUserById(authData.user.id, {
    app_metadata: { role: "tenant_admin", user_type: "wholesale", tenant_id: tenant.id },
  });
  if (metaError) {
    // 메타데이터 실패는 치명적이지 않음 (가입 자체는 성공) — 경고만
    console.error("[signup] app_metadata 업데이트 실패:", metaError);
  }

  return NextResponse.json({ success: true });
}
