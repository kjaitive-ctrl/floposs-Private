import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-admin";

// 도매 보드 클레임 — /s/<code> overlay 게이트에서 호출.
// 전화매칭(slot_stores 전화) 통과 시 slot별 보드계정(Supabase Auth) 생성 + 비번 설정.
// 하이재킹 가드: 보드가 overlay로 가려져 전화가 안 보임 → 그 매장 전화를 아는 도매만 클레임 가능.
// 인증 자체는 이후 supabaseBoard.signInWithPassword (sb-board-auth). [[project_logi_axis]]
const BOARD_EMAIL_DOMAIN = "board.floposs.local";
const onlyDigits = (s: string) => s.replace(/\D+/g, "");

export async function POST(req: NextRequest) {
  let body: { code?: string; phone?: string; password?: string };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "잘못된 요청" }, { status: 400 }); }

  const code = String(body.code ?? "").trim();
  const phoneDigits = onlyDigits(String(body.phone ?? ""));
  const password = String(body.password ?? "");

  if (!code) return NextResponse.json({ error: "보드 주소가 없습니다." }, { status: 400 });
  if (phoneDigits.length < 8) return NextResponse.json({ error: "매장 전화번호를 정확히 입력해주세요." }, { status: 400 });
  if (password.length < 6) return NextResponse.json({ error: "비밀번호는 6자 이상으로 설정해주세요." }, { status: 400 });

  // 1) slot 조회 (현재 매장명 포함 — 임시 tenant 이름용)
  const { data: slot } = await supabaseAdmin
    .from("slots")
    .select("id, building, floor, section, board_claimed_at")
    .eq("public_code", code)
    .maybeSingle();
  if (!slot) return NextResponse.json({ error: "존재하지 않는 보드입니다." }, { status: 404 });
  if (slot.board_claimed_at) {
    return NextResponse.json({ error: "이미 등록된 보드입니다. 비밀번호로 로그인하세요.", claimed: true }, { status: 409 });
  }

  // 2) 전화매칭 — 이 slot 의 매장 전화(phone/smartphone) 중 하나와 일치해야 함
  const { data: stores } = await supabaseAdmin
    .from("slot_stores")
    .select("store_name, phone, smartphone, is_current, store_order")
    .eq("slot_id", slot.id)
    .eq("is_hidden", false)
    .order("is_current", { ascending: false, nullsFirst: false })
    .order("store_order", { ascending: false });
  const phones = (stores ?? [])
    .flatMap(s => [s.phone, s.smartphone])
    .map(p => onlyDigits(p ?? ""))
    .filter(p => p.length >= 8);
  if (phones.length === 0) {
    return NextResponse.json({ error: "이 매장에 등록된 전화번호가 없어 자동 등록이 어렵습니다. 관리자에게 문의해주세요." }, { status: 422 });
  }
  if (!phones.includes(phoneDigits)) {
    return NextResponse.json({ error: "이 매장 전화번호와 일치하지 않습니다." }, { status: 403 });
  }

  const storeName = stores?.[0]?.store_name ?? "보드 도매";
  const f = slot.floor < 0 ? `B${-slot.floor}` : `${slot.floor}`;
  const loc = `${slot.building}${f}${slot.section ?? ""}`;
  const email = `slot-${code}@${BOARD_EMAIL_DOMAIN}`;

  // 3) 임시 도매 tenant 생성 (admin 도매업체관리에 임시아이디로 노출)
  const { data: tenant, error: tErr } = await supabaseAdmin
    .from("tenants")
    .insert({
      tenant_type: "wholesale",
      is_provisional: true,
      company_name: `${storeName} (${loc})`,
      phone: phoneDigits,
      category: "wholesale",
      is_active: true,
      status: "active",
    })
    .select("id")
    .single();
  if (tErr || !tenant) {
    return NextResponse.json({ error: tErr?.message ?? "임시 계정 생성 실패" }, { status: 400 });
  }

  // 4) slot별 보드계정 생성 (Supabase Auth) — tenant_id + board_slot_id 박제
  const { data: authData, error: authError } = await supabaseAdmin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    app_metadata: { user_type: "board", board_slot_id: slot.id, board_code: code, tenant_id: tenant.id },
  });
  if (authError) {
    await supabaseAdmin.from("tenants").delete().eq("id", tenant.id); // 롤백
    if (authError.message.includes("already")) {
      await supabaseAdmin.from("slots").update({ board_claimed_at: new Date().toISOString(), board_claim_phone: phoneDigits }).eq("id", slot.id);
      return NextResponse.json({ error: "이미 등록된 보드입니다. 비밀번호로 로그인하세요.", claimed: true }, { status: 409 });
    }
    return NextResponse.json({ error: authError.message }, { status: 400 });
  }

  // 5) users 레코드 + 클레임 상태 박제
  await supabaseAdmin.from("users").insert({
    id: authData.user!.id,
    tenant_id: tenant.id,
    email,
    name: storeName,
    role: "tenant_admin",
    user_type: "wholesale",
  });
  await supabaseAdmin.from("slots")
    .update({ board_claimed_at: new Date().toISOString(), board_claim_phone: phoneDigits, board_tenant_id: tenant.id })
    .eq("id", slot.id);

  return NextResponse.json({ success: true });
}
