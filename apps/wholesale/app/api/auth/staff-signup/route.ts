import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { getSessionInfo } from "@/lib/auth-server";

// 사장(tenant_admin) 이 같은 tenant 안에 매장계정(staff) 추가
export async function POST(req: NextRequest) {
  const session = await getSessionInfo();
  if (!session) {
    return NextResponse.json({ error: "로그인이 필요합니다." }, { status: 401 });
  }
  if (session.role !== "tenant_admin" && session.role !== "super_admin") {
    return NextResponse.json({ error: "매장계정 추가 권한이 없습니다." }, { status: 403 });
  }
  if (!session.tenantId) {
    return NextResponse.json({ error: "tenant 정보가 없습니다. 백필 후 다시 시도해주세요." }, { status: 400 });
  }

  const { email, password, name, role: roleInput, memo } = await req.json();
  if (!email || !password || !name) {
    return NextResponse.json({ error: "이메일/비밀번호/이름은 필수입니다." }, { status: 400 });
  }
  if (password.length < 6) {
    return NextResponse.json({ error: "비밀번호는 6자 이상이어야 합니다." }, { status: 400 });
  }
  // 역할 whitelist (tenant 안에서 사장이 발급 가능한 역할)
  const role: "staff" | "manager" = roleInput === "manager" ? "manager" : "staff";

  // 1) Auth 계정 생성 + app_metadata 동시 박기 (JWT claim 즉시 반영)
  const { data: authData, error: authError } = await supabaseAdmin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    app_metadata: { role, tenant_id: session.tenantId },
  });
  if (authError) {
    const msg = authError.message.includes("already registered") || authError.message.includes("already been registered")
      ? "이미 등록된 이메일입니다."
      : authError.message;
    return NextResponse.json({ error: msg }, { status: 400 });
  }

  // 2-pre) 생성자 public.users.id 조회 (auth.users.id != public.users.id 라 email 로 매칭)
  const { data: creatorRow } = await supabaseAdmin
    .from("users")
    .select("id")
    .eq("email", session.email)
    .maybeSingle();
  const creatorId: string | null = creatorRow?.id ?? null;

  // 2) public.users 행 생성 — created_by 에 생성자(tenant_admin) public.users.id 박제
  const { error: userError } = await supabaseAdmin.from("users").insert({
    tenant_id: session.tenantId,
    email,
    name,
    role,
    memo: memo ?? null,
    created_by: creatorId,
  });

  if (userError) {
    await supabaseAdmin.auth.admin.deleteUser(authData.user.id);
    return NextResponse.json({ error: userError.message }, { status: 400 });
  }

  return NextResponse.json({ success: true });
}

// 매장계정 리스트 (사장만)
export async function GET() {
  const session = await getSessionInfo();
  if (!session) return NextResponse.json({ error: "로그인이 필요합니다." }, { status: 401 });
  if (session.role !== "tenant_admin" && session.role !== "super_admin") {
    return NextResponse.json({ error: "권한이 없습니다." }, { status: 403 });
  }
  if (!session.tenantId) return NextResponse.json({ users: [] });

  const { data, error } = await supabaseAdmin
    .from("users")
    .select("id, email, name, role, memo, is_active, created_at, last_login_at, created_by")
    .eq("tenant_id", session.tenantId)
    .in("role", ["staff", "manager"])
    .order("created_at", { ascending: false });

  if (error) return NextResponse.json({ error: error.message }, { status: 400 });

  // 생성자 이름 resolve — 같은 tenant 의 tenant_admin 들 중에서 lookup
  const creatorIds = Array.from(new Set((data ?? []).map(u => u.created_by).filter((x): x is string => !!x)));
  const creatorMap = new Map<string, string>();
  if (creatorIds.length > 0) {
    const { data: creators } = await supabaseAdmin
      .from("users")
      .select("id, name, email")
      .in("id", creatorIds);
    (creators ?? []).forEach(c => creatorMap.set(c.id, c.name ?? c.email ?? ""));
  }
  const enriched = (data ?? []).map(u => ({
    ...u,
    created_by_name: u.created_by ? (creatorMap.get(u.created_by) ?? null) : null,
  }));
  return NextResponse.json({ users: enriched });
}

// 매장계정 수정 (이름/역할/메모/비밀번호) — 사장만
export async function PATCH(req: NextRequest) {
  const session = await getSessionInfo();
  if (!session) return NextResponse.json({ error: "로그인이 필요합니다." }, { status: 401 });
  if (session.role !== "tenant_admin" && session.role !== "super_admin") {
    return NextResponse.json({ error: "권한이 없습니다." }, { status: 403 });
  }

  const { user_id, name, role: roleInput, memo, password } = await req.json();
  if (!user_id) return NextResponse.json({ error: "user_id 누락" }, { status: 400 });
  if (password !== undefined && password !== "" && password.length < 6) {
    return NextResponse.json({ error: "비밀번호는 6자 이상이어야 합니다." }, { status: 400 });
  }

  // 같은 tenant 의 staff/manager 인지 검증
  const { data: target } = await supabaseAdmin
    .from("users")
    .select("id, tenant_id, role, email")
    .eq("id", user_id)
    .single();

  if (!target || target.tenant_id !== session.tenantId || !["staff", "manager"].includes(target.role)) {
    return NextResponse.json({ error: "잘못된 대상입니다." }, { status: 400 });
  }

  const role: "staff" | "manager" | undefined =
    roleInput === "manager" ? "manager" : roleInput === "staff" ? "staff" : undefined;

  // 1) public.users 갱신
  const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (name !== undefined)  updates.name = name;
  if (role !== undefined)  updates.role = role;
  if (memo !== undefined)  updates.memo = memo === "" ? null : memo;

  const { error: updErr } = await supabaseAdmin
    .from("users")
    .update(updates)
    .eq("id", user_id);
  if (updErr) return NextResponse.json({ error: updErr.message }, { status: 400 });

  // 2) auth.users 갱신 — role 변경 시 app_metadata + 비번 변경 시 password
  if (role !== undefined || (password !== undefined && password !== "")) {
    const { data: authList } = await supabaseAdmin.auth.admin.listUsers();
    const authUser = authList?.users?.find(u => u.email === target.email);
    if (authUser) {
      const authUpdates: { password?: string; app_metadata?: Record<string, unknown> } = {};
      if (password) authUpdates.password = password;
      if (role !== undefined) {
        authUpdates.app_metadata = { ...(authUser.app_metadata ?? {}), role };
      }
      await supabaseAdmin.auth.admin.updateUserById(authUser.id, authUpdates);
    }
  }

  return NextResponse.json({ success: true });
}

// 매장계정 비활성화 (삭제 대신 — created_by 등 FK 보존)
export async function DELETE(req: NextRequest) {
  const session = await getSessionInfo();
  if (!session) return NextResponse.json({ error: "로그인이 필요합니다." }, { status: 401 });
  if (session.role !== "tenant_admin" && session.role !== "super_admin") {
    return NextResponse.json({ error: "권한이 없습니다." }, { status: 403 });
  }

  const { user_id } = await req.json();
  if (!user_id) return NextResponse.json({ error: "user_id 누락" }, { status: 400 });

  // 같은 tenant 의 staff/manager 인지 검증
  const { data: target } = await supabaseAdmin
    .from("users")
    .select("id, tenant_id, role, email")
    .eq("id", user_id)
    .single();

  if (!target || target.tenant_id !== session.tenantId || !["staff", "manager"].includes(target.role)) {
    return NextResponse.json({ error: "잘못된 대상입니다." }, { status: 400 });
  }

  // 1) public.users 비활성화
  const { error: deactivateError } = await supabaseAdmin
    .from("users")
    .update({ is_active: false })
    .eq("id", user_id);
  if (deactivateError) {
    return NextResponse.json({ error: deactivateError.message }, { status: 400 });
  }

  // 2) auth.users 에서 같은 이메일 찾아서 즉시 차단 (sign out + ban)
  const { data: authList } = await supabaseAdmin.auth.admin.listUsers();
  const authUser = authList?.users?.find(u => u.email === target.email);
  if (authUser) {
    await supabaseAdmin.auth.admin.updateUserById(authUser.id, {
      ban_duration: "876000h", // 100년 (사실상 영구)
    });
  }

  return NextResponse.json({ success: true });
}
