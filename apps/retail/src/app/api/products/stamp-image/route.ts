// POST /api/products/stamp-image
//   body: { image_id: string, text: string }
//
// 흐름:
//   1) 인증 → tenant_id 확인, image_id → product → tenant 소유 검증 (r2/sign 라우트와 동일 패턴)
//   2) R2 key 해석. 백업(<key>.orig) 이 없으면(=첫 각인) 현재 오브젝트를 진짜 원본으로 백업.
//      있으면(=재각인) 그 백업본에서 다시 시작 — 텍스트가 텍스트 위에 겹쳐 쌓이는 것 방지.
//   3. 백업본 기준으로 텍스트 합성 → 같은 key 로 덮어쓰기. url 은 안 바뀌므로
//      cafe24 push 등 이 url 을 그대로 읽는 다른 흐름들은 자동으로 각인된 버전을 받게 됨.
//   4) product_images.stamp_label 갱신 (UI 표시/재각인 prefill 용)

import { NextRequest, NextResponse } from "next/server";
import { getSupabaseRouteClient } from "@/lib/supabase-server";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { getObjectBuffer, putObjectBuffer, tryGetObjectBuffer, keyFromPublicUrl } from "@/lib/r2";
import { stampImageBuffer } from "@/lib/textStamp";

const MAX_TEXT_LEN = 40;

export async function POST(req: NextRequest) {
  // 1) 인증
  const supabase = await getSupabaseRouteClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });

  const tenantId = (user.app_metadata as { tenant_id?: string } | undefined)?.tenant_id;
  if (!tenantId) return NextResponse.json({ error: "tenant_id not set" }, { status: 500 });

  // 2) body
  let body: { image_id?: unknown; text?: unknown };
  try { body = await req.json(); } catch {
    return NextResponse.json({ error: "잘못된 JSON" }, { status: 400 });
  }
  const imageId = typeof body.image_id === "string" ? body.image_id : "";
  const text = typeof body.text === "string" ? body.text.trim() : "";
  if (!imageId || !text) {
    return NextResponse.json({ error: "image_id, text 필수" }, { status: 400 });
  }
  if (text.length > MAX_TEXT_LEN) {
    return NextResponse.json({ error: `텍스트가 너무 깁니다 (${MAX_TEXT_LEN}자 이내)` }, { status: 400 });
  }

  // 3) 소유 검증 — image → product → tenant
  const { data: img } = await supabaseAdmin
    .from("product_images")
    .select("id, url, mime_type, product_id")
    .eq("id", imageId)
    .maybeSingle();
  if (!img) return NextResponse.json({ error: "이미지를 찾을 수 없습니다" }, { status: 404 });

  const { data: prod } = await supabaseAdmin
    .from("products")
    .select("id, tenant_id")
    .eq("id", img.product_id)
    .maybeSingle();
  if (!prod || prod.tenant_id !== tenantId) {
    return NextResponse.json({ error: "권한 없음" }, { status: 403 });
  }

  const key = keyFromPublicUrl(img.url);
  if (!key) return NextResponse.json({ error: "R2 key 해석 실패" }, { status: 500 });
  const backupKey = `${key}.orig`;
  const mime = img.mime_type || "image/jpeg";

  try {
    // 백업본이 있으면 그걸 원본으로, 없으면(첫 각인) 지금 것을 원본으로 삼아 먼저 백업.
    let original = await tryGetObjectBuffer(backupKey);
    if (!original) {
      original = await getObjectBuffer(key);
      await putObjectBuffer(backupKey, original, mime);
    }

    const stamped = await stampImageBuffer(original, mime, text);
    // 짧은 캐시 — CDN/브라우저가 덮어쓴 직후에도 옛 바이트를 오래 물고 있지 않도록.
    await putObjectBuffer(key, stamped, mime, "public, max-age=60, must-revalidate");

    await supabaseAdmin.from("product_images").update({ stamp_label: text }).eq("id", imageId);

    return NextResponse.json({ ok: true, stamp_label: text });
  } catch (e) {
    return NextResponse.json({ error: `각인 실패: ${String(e)}` }, { status: 500 });
  }
}
