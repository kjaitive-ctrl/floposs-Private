// POST /api/r2/sign-get
//   body: { items: Array<{ key: string; filename?: string }> }
//   응답: { urls: string[] }
//
// 다운로드용 presigned GET URL 일괄 발급.
//   - r2.dev public URL 의 CORS quirk 우회 (fetch 실패 회피)
//   - ResponseContentDisposition=attachment 헤더로 브라우저 자동 다운로드
// 단일 다운로드: 받은 url 을 a.href + a.click() 만 해도 동작
// 다중 다운로드: 각 url 을 fetch + JSZip (CORS 통과)

import { NextRequest, NextResponse } from "next/server";
import { getSupabaseRouteClient } from "@/lib/supabase-server";
import { getPresignedGetUrl, isKeyOwnedByTenant } from "@/lib/r2";

export async function POST(req: NextRequest) {
  const supabase = await getSupabaseRouteClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });

  const tenantId = (user.app_metadata as { tenant_id?: string } | undefined)?.tenant_id;
  if (!tenantId) return NextResponse.json({ error: "tenant_id not set" }, { status: 500 });

  let body: { items?: unknown };
  try { body = await req.json(); } catch {
    return NextResponse.json({ error: "잘못된 JSON" }, { status: 400 });
  }
  if (!Array.isArray(body.items) || body.items.length === 0) {
    return NextResponse.json({ error: "items 배열 필수" }, { status: 400 });
  }
  if (body.items.length > 200) {
    return NextResponse.json({ error: "한 번에 최대 200개" }, { status: 400 });
  }

  const items = body.items as Array<{ key?: unknown; filename?: unknown }>;
  const urls: string[] = [];
  for (const it of items) {
    const key = typeof it.key === "string" ? it.key : "";
    const filename = typeof it.filename === "string" ? it.filename : undefined;
    if (!key) return NextResponse.json({ error: "key 누락 항목 있음" }, { status: 400 });
    if (!isKeyOwnedByTenant(key, tenantId)) {
      return NextResponse.json({ error: "권한 없음 (다른 tenant key)" }, { status: 403 });
    }
    urls.push(await getPresignedGetUrl(key, filename));
  }

  return NextResponse.json({ urls });
}
