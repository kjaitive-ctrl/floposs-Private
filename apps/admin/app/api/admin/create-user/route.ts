import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-admin";

const ADMIN_EMAIL = "admin@kjretail.com";

// admin (super_admin) 이 wholesale 계정을 직접 등록 (retail/그외는 self-signup).
export async function POST(req: NextRequest) {
  // 요청자가 admin인지 확인
  const authHeader = req.headers.get("authorization");
  const token = authHeader?.replace("Bearer ", "");
  if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: { user } } = await supabaseAdmin.auth.getUser(token);
  if (user?.email !== ADMIN_EMAIL)
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const body = await req.json();
  const { email, password, company_name, business_number, owner_name, phone, address, category, plan_id, subscription_expires_at, admin_note } = body;

  if (!email || !password || !company_name)
    return NextResponse.json({ error: "필수 항목이 누락되었습니다." }, { status: 400 });

  // Supabase Auth 계정 생성 (admin 직접 등록 → 즉시 active. tenant_id 는 tenant 만든 후 update)
  const { data: authUser, error: authError } = await supabaseAdmin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    app_metadata: { role: "tenant_admin", user_type: "wholesale" },
  });
  if (authError) return NextResponse.json({ error: authError.message }, { status: 400 });

  // tenants 레코드 생성 (admin 직접 등록 → status='active')
  const { data: tenant, error: tenantError } = await supabaseAdmin
    .from("tenants")
    .insert({
      tenant_type: "wholesale",
      company_name,
      business_number: business_number || null,
      owner_name: owner_name || null,
      phone: phone || null,
      address: address || null,
      category: category || "wholesale",
      plan_id: plan_id || null,
      subscription_expires_at: subscription_expires_at || null,
      admin_note: admin_note || null,
      is_active: true,
      status: "active",
    })
    .select("id")
    .single();

  if (tenantError) {
    await supabaseAdmin.auth.admin.deleteUser(authUser.user!.id);
    return NextResponse.json({ error: tenantError.message }, { status: 400 });
  }

  // users 레코드 생성
  const { error: userError } = await supabaseAdmin.from("users").insert({
    tenant_id: tenant.id,
    email,
    name: company_name,
    role: "tenant_admin",
    user_type: "wholesale",
  });

  if (userError) {
    await supabaseAdmin.auth.admin.deleteUser(authUser.user!.id);
    await supabaseAdmin.from("tenants").delete().eq("id", tenant.id);
    return NextResponse.json({ error: userError.message }, { status: 400 });
  }

  // tenant_id 를 app_metadata 에 박기 (JWT claim 자동 포함)
  await supabaseAdmin.auth.admin.updateUserById(authUser.user!.id, {
    app_metadata: { role: "tenant_admin", user_type: "wholesale", tenant_id: tenant.id },
  });

  return NextResponse.json({ success: true, tenant_id: tenant.id });
}
