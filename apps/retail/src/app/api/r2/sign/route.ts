// POST /api/r2/sign
//   body: { product_id: string, mime: string }
//   응답: { key: string, upload_url: string, public_url: string }
//
// 흐름:
//   1) 인증 → tenant_id 확인 (AI route 와 동일 패턴)
//   2) product_id 가 본인 tenant 소유 검증 (위조 차단)
//   3) tenant prefix 로 key 생성 → presigned PUT URL 발급
//   4) 브라우저가 받은 upload_url 로 직접 R2 에 PUT (Vercel 우회)
//   5) 업로드 성공 시 브라우저가 supabase 직접 INSERT product_images

import { NextRequest, NextResponse } from "next/server";
import { getSupabaseRouteClient } from "@/lib/supabase-server";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { buildImageKey, getPresignedPutUrl, publicUrlForKey, extFromMime } from "@/lib/r2";

const ALLOWED_MIMES = new Set([
  "image/jpeg", "image/jpg", "image/png", "image/webp", "image/gif", "image/avif",
]);

export async function POST(req: NextRequest) {
  // 1) 인증
  const supabase = await getSupabaseRouteClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });

  const tenantId = (user.app_metadata as { tenant_id?: string } | undefined)?.tenant_id;
  if (!tenantId) return NextResponse.json({ error: "tenant_id not set" }, { status: 500 });

  // 2) body
  let body: { product_id?: unknown; mime?: unknown; file_size?: unknown };
  try { body = await req.json(); } catch {
    return NextResponse.json({ error: "잘못된 JSON" }, { status: 400 });
  }
  const productId = typeof body.product_id === "string" ? body.product_id : "";
  const mime = typeof body.mime === "string" ? body.mime.toLowerCase() : "";
  const fileSize = typeof body.file_size === "number" && body.file_size > 0 ? body.file_size : 0;
  if (!productId || !mime) {
    return NextResponse.json({ error: "product_id, mime 필수" }, { status: 400 });
  }
  if (!ALLOWED_MIMES.has(mime)) {
    return NextResponse.json({ error: `허용 안 된 mime: ${mime}` }, { status: 400 });
  }
  if (extFromMime(mime) === "bin") {
    return NextResponse.json({ error: "이미지 mime 만 허용" }, { status: 400 });
  }

  // 3) product_id 소유 검증 — service_role 로 tenant_id 일치 확인
  const { data: prod } = await supabaseAdmin
    .from("products")
    .select("id, tenant_id")
    .eq("id", productId)
    .maybeSingle();
  if (!prod) {
    return NextResponse.json({ error: "상품을 찾을 수 없습니다" }, { status: 404 });
  }
  if (prod.tenant_id !== tenantId) {
    return NextResponse.json({ error: "권한 없음" }, { status: 403 });
  }

  // 4) 한도 사전 체크 (마이그 200) — 초과 시 403
  const { data: quotaCheck, error: quotaError } = await supabaseAdmin
    .rpc("check_r2_quota", { p_tenant_id: tenantId, p_extra_bytes: fileSize });
  if (quotaError) {
    return NextResponse.json({ error: `한도 체크 실패: ${quotaError.message}` }, { status: 500 });
  }
  const quota = quotaCheck as {
    ok: boolean;
    reason?: string;
    usage_bytes?: number;
    quota_bytes?: number;
    remaining_bytes?: number;
  };
  if (!quota.ok) {
    return NextResponse.json({
      error: "용량 한도 초과 — 플랜 업그레이드가 필요합니다",
      quota,
    }, { status: 403 });
  }

  // 5) key 생성 + presigned URL 발급
  const key = buildImageKey(tenantId, productId, mime);
  const uploadUrl = await getPresignedPutUrl(key, mime);
  const publicUrl = publicUrlForKey(key);

  return NextResponse.json({
    key,
    upload_url: uploadUrl,
    public_url: publicUrl,
    quota,
  });
}
