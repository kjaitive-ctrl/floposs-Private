import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-admin";

// 전자노트 공개 보드 (안건3 받는쪽 v1). /s/<code> 가 호출.
// public_code 로 slot 1개만 scope — anon 이 전체 노트 못 긁게 server 에서 한정.
// 읽기 전용. 클레임/처리/티저 게이트는 Step II.
const PAGE = 100;

export async function GET(req: NextRequest, ctx: { params: Promise<{ code: string }> }) {
  const { code } = await ctx.params;
  if (!code) return NextResponse.json({ error: "no code" }, { status: 400 });
  const before = req.nextUrl.searchParams.get("before");  // sent_at 커서 (더보기)

  // 1) slot (public_code 로 단일 조회)
  const { data: slot } = await supabaseAdmin
    .from("slots")
    .select("id, building, floor, section")
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

  // 3) 그 slot 으로 온 노트 (최신순, 페이지네이션) + 발신 소매명 + 라인
  let q = supabaseAdmin
    .from("order_notes")
    .select(`
      id, sent_at, is_test,
      sender:tenants!sender_retail_tenant_id ( company_name ),
      items:order_note_items (
        supplier_product_name, consumer_product_name,
        supplier_option_label, consumer_option_label, quantity, unit_price, variant_barcode
      )
    `)
    .eq("recipient_slot_id", slot.id)
    .eq("is_hidden", false)
    .order("sent_at", { ascending: false })
    .limit(PAGE);
  if (before) q = q.lt("sent_at", before);
  const { data: notes } = await q;

  const f = slot.floor < 0 ? `B${-slot.floor}` : `${slot.floor}`;
  const loc = `${slot.building}${f}${slot.section ?? ""}`;

  return NextResponse.json({
    store_name: store?.store_name ?? "(매장)",
    loc,
    notes: notes ?? [],
    hasMore: (notes?.length ?? 0) === PAGE,  // 더 있을 수 있음
  });
}
