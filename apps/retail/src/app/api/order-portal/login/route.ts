import { NextRequest, NextResponse } from "next/server";
import { getSupabaseRouteClient } from "@/lib/supabase-server";
import { isValidPhone, isLoginSecretShape, phoneToEmail } from "@/lib/orderPortal";

// 휴대폰 + 비밀번호 → dummy email 재구성 → Supabase Auth signInWithPassword.
// 입력 검증은 완화(레거시 4자리 ∪ 신규 복잡 비번) — 실제 일치는 Auth 가 판정.
// 세션 cookie 가 응답에 박혀서 후속 요청에서 인증됨.
export async function POST(req: NextRequest) {
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "잘못된 요청입니다." }, { status: 400 });
  }

  const phone = String(body.phone ?? "").trim();
  const pin = String(body.pin ?? "").trim();

  if (!isValidPhone(phone) || !isLoginSecretShape(pin)) {
    return NextResponse.json({ error: "휴대폰 번호 또는 비밀번호가 올바르지 않습니다." }, { status: 400 });
  }

  const supabase = await getSupabaseRouteClient();
  const { error } = await supabase.auth.signInWithPassword({
    email: phoneToEmail(phone),
    password: pin,
  });

  if (error) {
    return NextResponse.json({ error: "휴대폰 번호 또는 비밀번호가 올바르지 않습니다." }, { status: 400 });
  }

  return NextResponse.json({ success: true });
}
