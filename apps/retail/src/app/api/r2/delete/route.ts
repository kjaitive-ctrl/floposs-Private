// POST /api/r2/delete
//   body: { key: string }  — R2 object key (URL 이 아님)
//   응답: { ok: true }
//
// 정공법: DB delete 와 R2 delete 분리. 브라우저가 supabase 직접 DELETE 한 뒤 이 route 호출.
// 순서:
//   1) 인증 + tenant prefix 검증 (tampering 차단)
//   2) R2 DeleteObject
// DB 측 product_images row 는 호출자(브라우저)가 supabase 로 직접 삭제.
// R2 삭제 실패해도 DB 는 이미 비어있을 수 있음 → orphan 만 남고 사용자는 안 보임 (월 reconcile 시 정리).

import { NextRequest, NextResponse } from "next/server";
import { getSupabaseRouteClient } from "@/lib/supabase-server";
import { deleteObject, isKeyOwnedByTenant } from "@/lib/r2";

export async function POST(req: NextRequest) {
  const supabase = await getSupabaseRouteClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });

  const tenantId = (user.app_metadata as { tenant_id?: string } | undefined)?.tenant_id;
  if (!tenantId) return NextResponse.json({ error: "tenant_id not set" }, { status: 500 });

  let body: { key?: unknown };
  try { body = await req.json(); } catch {
    return NextResponse.json({ error: "잘못된 JSON" }, { status: 400 });
  }
  const key = typeof body.key === "string" ? body.key : "";
  if (!key) return NextResponse.json({ error: "key 필수" }, { status: 400 });

  // tenant prefix 일치 검증 — 다른 tenant 데이터 삭제 시도 차단
  if (!isKeyOwnedByTenant(key, tenantId)) {
    return NextResponse.json({ error: "권한 없음" }, { status: 403 });
  }

  try {
    await deleteObject(key);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: `R2 삭제 실패: ${message}` }, { status: 502 });
  }

  return NextResponse.json({ ok: true });
}
