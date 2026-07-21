import { NextRequest, NextResponse } from "next/server";
import { getSupabaseRouteClient } from "@/lib/supabase-server";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { getValidTokenForTenant, cafe24Api } from "@/lib/cafe24";

// POST /api/cafe24/display — 상품 진열(display) on/off. 시즌오프/재진행/상품현황 토글에서 호출.
// body: { productId: string, display: "T" | "F" }
// cafe24_product_no 없는 상품(카페24 미등록)이면 400 — 호출부가 버튼 비활성으로 사전 차단해야 함.
export async function POST(req: NextRequest) {
  const supabase = await getSupabaseRouteClient();
  const { data: { user } } = await supabase.auth.getUser();
  const tenantId = (user?.app_metadata as { tenant_id?: string } | undefined)?.tenant_id;
  if (!tenantId) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });

  let body: { productId?: string; display?: string };
  try { body = await req.json(); }
  catch { return NextResponse.json({ error: "잘못된 요청 body" }, { status: 400 }); }
  const { productId, display } = body;
  if (!productId || (display !== "T" && display !== "F"))
    return NextResponse.json({ error: "productId, display(T/F) 필요" }, { status: 400 });

  const db = supabaseAdmin;
  const { data: product } = await db
    .from("products")
    .select("id, cafe24_product_no")
    .eq("id", productId)
    .eq("tenant_id", tenantId)
    .maybeSingle();
  if (!product) return NextResponse.json({ error: "상품을 찾을 수 없습니다" }, { status: 404 });
  if (!product.cafe24_product_no)
    return NextResponse.json({ error: "카페24 미등록 상품입니다. 먼저 카페24로 전송해주세요." }, { status: 400 });

  const token = await getValidTokenForTenant(tenantId);
  if (!token) return NextResponse.json({ error: "카페24 미연동 또는 토큰 만료. 설정에서 카페24 재연동 해주세요." }, { status: 400 });

  try {
    await cafe24Api(token.mall_id, token.access_token, "PUT", `products/${product.cafe24_product_no}`, {
      shop_no: 1,
      request: { display },
    });
  } catch (e) {
    return NextResponse.json({ error: String(e).slice(0, 500) }, { status: 502 });
  }

  // 로컬 미러 — 실제 카페24 진열상태를 매번 조회하지 않고 마지막 PUT 결과를 캐싱 (마이그 216).
  await db.from("products").update({ cafe24_display: display === "T" }).eq("id", productId);

  return NextResponse.json({ ok: true });
}
