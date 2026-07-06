import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { getSupabaseRouteClient } from "@/lib/supabase-server";

const admin = () => createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { autoRefreshToken: false, persistSession: false } }
);

async function getTenantId(): Promise<string | null> {
  const supabase = await getSupabaseRouteClient();
  const { data: { user } } = await supabase.auth.getUser();
  return (user?.app_metadata as { tenant_id?: string } | undefined)?.tenant_id ?? null;
}

// GET — 현재 매핑 { retail_category → cafe24_category_no } 목록 반환
export async function GET() {
  const tenantId = await getTenantId();
  if (!tenantId) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });

  const db = admin();
  const { data } = await db
    .from("tenant_category_mapping")
    .select("retail_category, cafe24_category_no")
    .eq("retail_tenant_id", tenantId);

  return NextResponse.json({ mappings: data ?? [] });
}

// POST — 매핑 저장 { mappings: [{ retail_category, cafe24_category_no }] }
export async function POST(req: NextRequest) {
  const tenantId = await getTenantId();
  if (!tenantId) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });

  const { mappings } = await req.json() as {
    mappings: { retail_category: string; cafe24_category_no: number | null }[];
  };

  const db = admin();

  // 0 또는 null 은 "미지정" → 해당 카테고리 행 삭제
  const toDelete = mappings.filter(m => !m.cafe24_category_no).map(m => m.retail_category);
  const toUpsert = mappings
    .filter(m => !!m.cafe24_category_no)
    .map(m => ({
      retail_tenant_id: tenantId,
      retail_category: m.retail_category,
      cafe24_category_no: m.cafe24_category_no!,
    }));

  if (toDelete.length > 0) {
    await db.from("tenant_category_mapping")
      .delete()
      .eq("retail_tenant_id", tenantId)
      .in("retail_category", toDelete);
  }
  if (toUpsert.length > 0) {
    const { error } = await db.from("tenant_category_mapping")
      .upsert(toUpsert, { onConflict: "retail_tenant_id,retail_category" });
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
