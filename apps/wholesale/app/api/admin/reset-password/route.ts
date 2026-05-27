import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-admin";

// admin (super_admin) 이 특정 계정의 비밀번호를 강제로 새 값으로 교체.
// 이메일 기반 self-reset 대신 admin 이 직접 발급해주는 흐름.
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

  const { email, new_password } = await req.json();
  if (!email || !new_password) {
    return NextResponse.json({ error: "email, new_password 누락" }, { status: 400 });
  }
  if (new_password.length < 6) {
    return NextResponse.json({ error: "비밀번호는 6자 이상이어야 합니다." }, { status: 400 });
  }

  // public.users.id != auth.users.id 일 수 있으므로 email 로 auth user 조회
  const { data: authList } = await supabaseAdmin.auth.admin.listUsers();
  const authUser = authList?.users?.find(u => u.email === email);
  if (!authUser) {
    return NextResponse.json({ error: "해당 이메일의 인증 계정을 찾을 수 없습니다." }, { status: 404 });
  }

  const { error } = await supabaseAdmin.auth.admin.updateUserById(authUser.id, {
    password: new_password,
  });
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 400 });
  }

  return NextResponse.json({ success: true });
}
