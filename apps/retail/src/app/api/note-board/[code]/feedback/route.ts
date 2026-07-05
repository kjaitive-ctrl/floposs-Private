import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-admin";

// 도매 출고피드백 저장 — 보드(/s) 인증 클레이머만. order_note_items.shipped_quantity/ship_memo.
// 보안: 보드 토큰의 board_slot_id === 이 slot 이어야 + 이 slot 의 노트 라인만 수정(서버 강제). [[project_logi_axis]]
export async function POST(req: NextRequest, ctx: { params: Promise<{ code: string }> }) {
  const { code } = await ctx.params;
  const token = req.headers.get("authorization")?.replace("Bearer ", "");
  if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: { user } } = await supabaseAdmin.auth.getUser(token);
  const meta = user?.app_metadata as { board_slot_id?: string } | undefined;
  if (!meta?.board_slot_id) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  // slot 확인 (code ↔ 토큰의 board_slot_id 일치)
  const { data: slot } = await supabaseAdmin
    .from("slots").select("id").eq("public_code", code).maybeSingle();
  if (!slot || slot.id !== meta.board_slot_id) {
    return NextResponse.json({ error: "보드 권한이 없습니다." }, { status: 403 });
  }

  let body: { items?: { id: string; shipped_quantity: number | null; ship_memo: string | null }[] };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "잘못된 요청" }, { status: 400 }); }
  const items = body.items ?? [];
  if (items.length === 0) return NextResponse.json({ success: true });

  // 이 slot 으로 온 노트 id 들 (수정 범위 강제)
  const { data: noteRows } = await supabaseAdmin
    .from("order_notes").select("id").eq("recipient_slot_id", slot.id);
  const noteIds = (noteRows ?? []).map(n => n.id);
  if (noteIds.length === 0) return NextResponse.json({ error: "주문이 없습니다." }, { status: 400 });

  // 라인별 출고수량/메모 저장 (이 slot 노트의 라인만)
  for (const it of items) {
    const qty = it.shipped_quantity == null || Number.isNaN(Number(it.shipped_quantity))
      ? null : Math.max(0, Math.trunc(Number(it.shipped_quantity)));
    await supabaseAdmin.from("order_note_items")
      .update({ shipped_quantity: qty, ship_memo: it.ship_memo?.trim() || null })
      .eq("id", it.id)
      .in("note_id", noteIds);
  }

  return NextResponse.json({ success: true });
}
