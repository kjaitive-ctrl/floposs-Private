import { NextRequest, NextResponse } from "next/server";
import { getSupabaseRouteClient } from "@/lib/supabase-server";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { buildThumbnailAsset } from "@/lib/thumbnailGif";

interface Body { productId: string }
interface DbImage { url: string; sort_order: number | null; image_type: string | null }

// POST /api/products/thumbnail-export — 상품 1개의 썸네일(image_type='thumbnail') 이미지를
// GIF(2장+, 2초 간격)/단일 JPEG(1장)로 합성해 바이너리로 반환. 다운로드 전용, 카페24 전송과 무관.
export async function POST(req: NextRequest) {
  const supabase = await getSupabaseRouteClient();
  const { data: { user } } = await supabase.auth.getUser();
  const tenantId = (user?.app_metadata as { tenant_id?: string } | undefined)?.tenant_id;
  if (!tenantId) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });

  let body: Body;
  try { body = await req.json() as Body; }
  catch { return NextResponse.json({ error: "잘못된 요청 body" }, { status: 400 }); }
  if (!body.productId) return NextResponse.json({ error: "productId 필요" }, { status: 400 });

  const { data: product } = await supabaseAdmin
    .from("products")
    .select("id, product_images(url, sort_order, image_type)")
    .eq("id", body.productId)
    .eq("tenant_id", tenantId)
    .single();
  if (!product) return NextResponse.json({ error: "상품 없음" }, { status: 404 });

  const images = (product as unknown as { product_images: DbImage[] }).product_images ?? [];
  const thumbUrls = images
    .filter(img => img.image_type === "thumbnail")
    .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0))
    .map(img => img.url);

  const asset = await buildThumbnailAsset(thumbUrls);
  if (!asset) return NextResponse.json({ error: "썸네일 이미지 없음" }, { status: 400 });

  return new NextResponse(new Uint8Array(asset.buffer), {
    headers: {
      "Content-Type": asset.mime,
      "X-Thumbnail-Ext": asset.ext,
      "Cache-Control": "no-store",
    },
  });
}
