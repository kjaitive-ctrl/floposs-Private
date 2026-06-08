import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-admin";

// super_admin 이 물류회사(삼촌) 계정을 직접 발급. (logi 는 자가가입 X — account_types.is_signup_enabled=false)
// tenant_type='logistics', user_type='logistics'. 이메일+비밀번호 로그인 (logi 앱에서 사용).
// 여러 삼촌(기사)은 logi 회사 내부 분배 — v1 은 회사 1계정. [[project_logi_axis]]

// 비밀번호 정책: 8자 이상 + 영문 + 숫자 + 특수문자. (retail/admin 과 동일)
function isValidPassword(pw: string): boolean {
  return pw.length >= 8 && /[A-Za-z]/.test(pw) && /\d/.test(pw) && /[^A-Za-z0-9]/.test(pw);
}

export async function POST(req: NextRequest) {
  // 요청자 super_admin 검증
  const authHeader = req.headers.get("authorization");
  const token = authHeader?.replace("Bearer ", "");
  if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: { user: caller } } = await supabaseAdmin.auth.getUser(token);
  const callerRole = (caller?.app_metadata as { role?: string } | undefined)?.role;
  if (callerRole !== "super_admin") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const body = await req.json();
  const email = String(body.email ?? "").trim().toLowerCase();
  const password = String(body.password ?? "");
  const companyName = String(body.company_name ?? "").trim();   // 물류회사명
  const phone = String(body.phone ?? "").trim();

  if (!email || !password || !companyName) {
    return NextResponse.json({ error: "회사명·이메일·비밀번호는 필수입니다." }, { status: 400 });
  }
  if (!isValidPassword(password)) {
    return NextResponse.json({ error: "비밀번호는 영문·숫자·특수문자를 포함해 8자 이상이어야 합니다." }, { status: 400 });
  }

  // 1) Auth 계정 생성
  const { data: authUser, error: authError } = await supabaseAdmin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    app_metadata: { role: "tenant_admin", user_type: "logistics" },
  });
  if (authError) {
    const msg = authError.message.includes("already")
      ? "이미 등록된 이메일입니다."
      : authError.message;
    return NextResponse.json({ error: msg }, { status: 400 });
  }

  // 2) tenants (tenant_type='logistics', 구독 개념 없음 → plan_id null)
  const { data: tenant, error: tenantError } = await supabaseAdmin
    .from("tenants")
    .insert({
      tenant_type: "logistics",
      company_name: companyName,
      phone: phone || null,
      category: "logistics",
      is_active: true,
      status: "active",
    })
    .select("id")
    .single();

  if (tenantError) {
    await supabaseAdmin.auth.admin.deleteUser(authUser.user!.id);
    return NextResponse.json({ error: tenantError.message }, { status: 400 });
  }

  // 3) users 레코드
  const { error: userError } = await supabaseAdmin.from("users").insert({
    id: authUser.user!.id,
    tenant_id: tenant.id,
    email,
    name: companyName,
    phone: phone || null,
    role: "tenant_admin",
    user_type: "logistics",
  });
  if (userError) {
    await supabaseAdmin.auth.admin.deleteUser(authUser.user!.id);
    await supabaseAdmin.from("tenants").delete().eq("id", tenant.id);
    return NextResponse.json({ error: userError.message }, { status: 400 });
  }

  // 4) tenant_id 를 app_metadata 에 박기 (JWT claim)
  await supabaseAdmin.auth.admin.updateUserById(authUser.user!.id, {
    app_metadata: { role: "tenant_admin", user_type: "logistics", tenant_id: tenant.id },
  });

  return NextResponse.json({ success: true, tenant_id: tenant.id });
}
