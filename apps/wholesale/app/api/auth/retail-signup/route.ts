import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-admin";

// 2026-05-14 마이그 175 정착: retail_retailers/retail_users 폐기. 단일 tenants(C-1) 모델.
// retail vertical = tenants(tenant_type='retail') + users(tenant_id, user_type='retail').
// 외부 주문 포털(v1)은 별도 라우트(/api/order-portal/signup)에서 dummy email + PIN 처리.
// 본 라우트는 3000 /login 의 RetailSignupForm 진입점(이메일/비밀번호 정식 가입) 유지.

export async function POST(req: NextRequest) {
  const { email, password, company_name, owner_name, phone, business_number } = await req.json();

  if (!email || !password || !company_name)
    return NextResponse.json({ error: "필수 항목이 누락되었습니다." }, { status: 400 });

  // Auth 계정 생성 (tenant_id 는 tenants INSERT 후 update)
  const { data: authData, error: authError } = await supabaseAdmin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    app_metadata: { role: "tenant_admin", user_type: "retail" },
  });
  if (authError) {
    const msg = authError.message.includes("already registered") || authError.message.includes("already been registered")
      ? "이미 등록된 이메일입니다."
      : authError.message;
    return NextResponse.json({ error: msg }, { status: 400 });
  }

  // tenants 생성 (tenant_type='retail')
  const { data: tenant, error: tenantError } = await supabaseAdmin
    .from("tenants")
    .insert({
      tenant_type: "retail",
      company_name,
      owner_name,
      phone,
      business_number,
      is_active: true,
      status: "active",   // retail 자가가입 = 자동 활성 (승인 개념 없음)
    })
    .select("id")
    .single();

  if (tenantError) {
    await supabaseAdmin.auth.admin.deleteUser(authData.user.id);
    const msg = tenantError.code === "23505"
      ? "이미 등록된 사업자번호입니다."
      : tenantError.message;
    return NextResponse.json({ error: msg }, { status: 400 });
  }

  // users 생성 (단일 회원 DB, tenant_id 박제)
  const { error: userError } = await supabaseAdmin.from("users").insert({
    tenant_id: tenant.id,
    email,
    name: owner_name ?? company_name,
    phone,
    role: "tenant_admin",
    user_type: "retail",
  });

  if (userError) {
    await supabaseAdmin.auth.admin.deleteUser(authData.user.id);
    await supabaseAdmin.from("tenants").delete().eq("id", tenant.id);
    return NextResponse.json({ error: userError.message }, { status: 400 });
  }

  // tenant_id 를 app_metadata 에 박기 (JWT claim 으로 자동 포함)
  const { error: metaError } = await supabaseAdmin.auth.admin.updateUserById(authData.user.id, {
    app_metadata: { role: "tenant_admin", user_type: "retail", tenant_id: tenant.id },
  });
  if (metaError) {
    console.error("[retail-signup] app_metadata 업데이트 실패:", metaError);
  }

  return NextResponse.json({ success: true });
}
