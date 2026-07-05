import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-admin";

// 전자노트 보드 (도매 수신). /s/<code> 가 호출.
// 프라이버시 게이트: 인증된 클레이머(보드계정)만 상세, 미인증은 티저(건수/매장명만).
//   - 인증 = Authorization Bearer (sb-board-auth access token) → app_metadata.board_slot_id === slot.id
//   - RLS off 라 서버에서 강제. [[project_logi_axis]]
const PAGE = 100;

export async function GET(req: NextRequest, ctx: { params: Promise<{ code: string }> }) {
  const { code } = await ctx.params;
  if (!code) return NextResponse.json({ error: "no code" }, { status: 400 });
  const before = req.nextUrl.searchParams.get("before");

  // 1) slot
  const { data: slot } = await supabaseAdmin
    .from("slots")
    .select("id, building, floor, section, board_claimed_at")
    .eq("public_code", code)
    .maybeSingle();
  if (!slot) return NextResponse.json({ error: "not found" }, { status: 404 });

  // 2) 현재 매장명
  const { data: store } = await supabaseAdmin
    .from("slot_stores")
    .select("store_name")
    .eq("slot_id", slot.id)
    .eq("is_hidden", false)
    .order("is_current", { ascending: false, nullsFirst: false })
    .order("store_order", { ascending: false })
    .limit(1)
    .maybeSingle();

  // 3) 인증 확인 (이 slot 의 보드계정인지)
  let authed = false;
  const token = req.headers.get("authorization")?.replace("Bearer ", "");
  if (token) {
    const { data: { user } } = await supabaseAdmin.auth.getUser(token);
    if ((user?.app_metadata as { board_slot_id?: string } | undefined)?.board_slot_id === slot.id) authed = true;
  }

  const f = slot.floor < 0 ? `B${-slot.floor}` : `${slot.floor}`;
  const loc = `${slot.building}${f}${slot.section ?? ""}`;
  const head = {
    store_name: store?.store_name ?? "(매장)",
    loc,
    claimed: !!slot.board_claimed_at,
    authed,
  };

  // 4) 노트 조회
  let q = supabaseAdmin
    .from("order_notes")
    .select(
      authed
        ? `id, sent_at, is_test, pickup_status,
           sender:tenants!sender_retail_tenant_id ( company_name ),
           items:order_note_items (
             id, supplier_product_name, consumer_product_name,
             supplier_option_label, consumer_option_label, quantity, unit_price,
             variant_barcode, shipped_quantity, ship_memo
           )`
        : `id, sent_at, is_test,
           sender:tenants!sender_retail_tenant_id ( company_name ),
           items:order_note_items ( quantity )`
    )
    .eq("recipient_slot_id", slot.id)
    .eq("is_hidden", false)
    .order("sent_at", { ascending: false })
    .limit(PAGE);
  if (before) q = q.lt("sent_at", before);
  const { data: rows } = await q;

  type Row = {
    id: string; sent_at: string; is_test: boolean; pickup_status?: string;
    sender: { company_name: string | null } | { company_name: string | null }[] | null;
    items: { quantity: number }[] | null;
  };
  const list = (rows ?? []) as unknown as Row[];

  // 미인증 = 티저(건수/수량만, 상세·단가 제거)
  const notes = authed
    ? list
    : list.map(r => ({
        id: r.id,
        sent_at: r.sent_at,
        is_test: r.is_test,
        sender: r.sender,
        item_count: (r.items ?? []).length,
        total_qty: (r.items ?? []).reduce((a, i) => a + (i.quantity ?? 0), 0),
      }));

  return NextResponse.json({
    ...head,
    notes,
    hasMore: list.length === PAGE,
  });
}
