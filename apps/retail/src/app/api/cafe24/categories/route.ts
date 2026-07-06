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

// GET /api/cafe24/categories — 카페24 카테고리 목록 (sync + 반환).
// 연동된 경우 cafe24에서 직접 fetch → tenant_cafe24_categories 에 upsert → 반환.
export async function GET() {
  const supabase = await getSupabaseRouteClient();
  const { data: { user } } = await supabase.auth.getUser();
  const tenantId = (user?.app_metadata as { tenant_id?: string } | undefined)?.tenant_id;
  if (!tenantId) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });

  const token = await getValidTokenForTenant(tenantId);
  if (!token) return NextResponse.json({ error: "카페24 미연동" }, { status: 400 });

  try {
    const result = await cafe24Api<{ categories: Cafe24Cat[] }>(
      token.mall_id, token.access_token, "GET", "categories?limit=200"
    );
    const categories = result.categories ?? [];

    if (categories.length > 0) {
      const db = admin();
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
