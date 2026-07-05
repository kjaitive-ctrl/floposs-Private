import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-admin";

// 보드 발급/리셋 폴백 — super_admin 이 전화매칭 없이 slot 보드 계정을 직접 발급(또는 비번 리셋).
// 전화 데이터가 깨졌거나 비번분실 시 안전망. (정상 흐름은 도매 자가 클레임 = 전화매칭) [[project_logi_axis]]
const BOARD_EMAIL_DOMAIN = "board.floposs.local";

export async function POST(req: NextRequest) {
  const token = req.headers.get("authorization")?.replace("Bearer ", "");
  if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { data: { user: caller } } = await supabaseAdmin.auth.getUser(token);
  if ((caller?.app_metadata as { role?: string } | undefined)?.role !== "super_admin") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { slot_id, password } = await req.json();
  if (!slot_id || !password) return NextResponse.json({ error: "slot_id, password 누락" }, { status: 400 });
  if (String(password).length < 6) return NextResponse.json({ error: "비밀번호는 6자 이상이어야 합니다." }, { status: 400 });

  // slot 조회
  const { data: slot } = await supabaseAdmin
    .from("slots")
    .select("id, public_code, board_claimed_at, board_tenant_id, building, floor, section")
    .eq("id", slot_id)
    .maybeSingle();
  if (!slot) return NextResponse.json({ error: "slot 없음" }, { status: 404 });
  if (!slot.public_code) return NextResponse.json({ error: "이 자리에 보드 주소(public_code)가 없습니다." }, { status: 400 });

  const email = `slot-${slot.public_code}@${BOARD_EMAIL_DOMAIN}`;

  // 기존 보드계정 찾기 (있으면 리셋, 없으면 발급)
  const { data: list } = await supabaseAdmin.auth.admin.listUsers({ perPage: 1000 });
  const existing = list?.users?.find(u => u.email === email);

  if (existing) {
    const { error } = await supabaseAdmin.auth.admin.updateUserById(existing.id, { password: String(password) });
    if (error) return NextResponse.json({ error: error.message }, { status: 400 });
    if (!slot.board_claimed_at) {
      await supabaseAdmin.from("slots").update({ board_claimed_at: new Date().toISOString() }).eq("id", slot.id);
    }
    return NextResponse.json({ success: true, reset: true, code: slot.public_code });
  }

  // 신규 발급 — 현재 매장명 + 임시 tenant + 보드계정
  const { data: store } = await supabaseAdmin
    .from("slot_stores").select("store_name")
    .eq("slot_id", slot.id).eq("is_hidden", false)
    .order("is_current", { ascending: false, nullsFirst: false })
    .order("store_order", { ascending: false }).limit(1).maybeSingle();
  const f = slot.floor < 0 ? `B${-slot.floor}` : `${slot.floor}`;
  const loc = `${slot.building}${f}${slot.section ?? ""}`;
  const storeName = store?.store_name ?? "보드 도매";

  const { data: tenant, error: tErr } = await supabaseAdmin
    .from("tenants")
    .insert({ tenant_type: "wholesale", is_provisional: true, company_name: `${storeName} (${loc})`, category: "wholesale", is_active: true, status: "active" })
    .select("id").single();
  if (tErr || !tenant) return NextResponse.json({ error: tErr?.message ?? "임시 계정 생성 실패" }, { status: 400 });

  const { data: authData, error: aErr } = await supabaseAdmin.auth.admin.createUser({
    email, password: String(password), email_confirm: true,
    app_metadata: { user_type: "board", board_slot_id: slot.id, board_code: slot.public_code, tenant_id: tenant.id },
  });
  if (aErr) {
    await supabaseAdmin.from("tenants").delete().eq("id", tenant.id);
    return NextResponse.json({ error: aErr.message }, { status: 400 });
  }
  await supabaseAdmin.from("users").insert({
    id: authData.user!.id, tenant_id: tenant.id, email, name: storeName, role: "tenant_admin", user_type: "wholesale",
  });
  await supabaseAdmin.from("slots")
    .update({ board_claimed_at: new Date().toISOString(), board_tenant_id: tenant.id })
    .eq("id", slot.id);

  return NextResponse.json({ success: true, issued: true, code: slot.public_code });
}
