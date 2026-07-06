import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { getSupabaseRouteClient } from "@/lib/supabase-server";
import { getValidTokenForTenant, cafe24Api } from "@/lib/cafe24";

const admin = () => createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { autoRefreshToken: false, persistSession: false } }
);

interface Cafe24Cat {
  category_no: number;
  parent_category_no: number | null;
  category_name: string;
}

// GET /api/cafe24/categories — 카테고리 목록 반환.
// ?sync=1 : cafe24 API 직접 호출 → DB upsert → 반환 (버튼 클릭 시)
// 기본     : DB 캐시(tenant_cafe24_categories)만 읽기 (페이지 로드 시 자동)
export async function GET(req: Request) {
  const supabase = await getSupabaseRouteClient();
  const { data: { user } } = await supabase.auth.getUser();
  const tenantId = (user?.app_metadata as { tenant_id?: string } | undefined)?.tenant_id;
  if (!tenantId) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });

  const db = admin();
  const doSync = new URL(req.url).searchParams.get("sync") === "1";

  if (!doSync) {
    // DB 캐시 반환 (cafe24 API 호출 X)
    const { data } = await db
      .from("tenant_cafe24_categories")
      .select("cafe24_category_no, parent_no, name")
      .eq("retail_tenant_id", tenantId)
      .order("cafe24_category_no", { ascending: true });
    const categories = (data ?? []).map((r: { cafe24_category_no: number; parent_no: number | null; name: string }) => ({
      category_no: r.cafe24_category_no,
      parent_category_no: r.parent_no,
      category_name: r.name,
    }));
    return NextResponse.json({ categories });
  }

  // sync=1: cafe24 API 호출
  const token = await getValidTokenForTenant(tenantId);
  if (!token) return NextResponse.json({ error: "카페24 미연동" }, { status: 400 });

  try {
    const result = await cafe24Api<{ categories: Cafe24Cat[] }>(
      token.mall_id, token.access_token, "GET", "categories?limit=100"
    );
    const categories = result.categories ?? [];

    if (categories.length > 0) {
      await db.from("tenant_cafe24_categories").upsert(
        categories.map(c => ({
          retail_tenant_id: tenantId,
          cafe24_category_no: c.category_no,
          parent_no: c.parent_category_no ?? null,
          name: c.category_name,
          synced_at: new Date().toISOString(),
        })),
        { onConflict: "retail_tenant_id,cafe24_category_no" }
      );
    }

    return NextResponse.json({ categories });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
