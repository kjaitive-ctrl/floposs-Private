import { NextRequest, NextResponse } from "next/server";
import { getSupabaseRouteClient } from "@/lib/supabase-server";
import { supabaseAdmin } from "@/lib/supabase-admin";

// 해당 wholesale tenant 의 active products + active variants 목록.
// 단가/원가 응답 제외 (retail user 단가 노출 X 정책).
export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const supabase = await getSupabaseRouteClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }

  const { id: tenantId } = await ctx.params;

  // wholesale tenant 확인
  const { data: tenant, error: tenantErr } = await supabaseAdmin
    .from("tenants")
    .select("id, company_name, tenant_type, is_active")
    .eq("id", tenantId)
    .single();

  if (tenantErr || !tenant || tenant.tenant_type !== "wholesale" || !tenant.is_active) {
    return NextResponse.json({ error: "도매 매장을 찾을 수 없습니다." }, { status: 404 });
  }

  const q = (req.nextUrl.searchParams.get("q") ?? "").trim();

  // base_price/sale_price 까지 가져와서 variants 단가 계산 (SaleForm 패턴: is_sale ? sale_price : base_price)
  let productsQuery = supabaseAdmin
    .from("products")
    .select("id, name, product_code, category, base_price, sale_price")
    .eq("tenant_id", tenantId)
    .eq("is_active", true)
    .order("name", { ascending: true })
    .limit(200);

  if (q) {
    const like = `%${q}%`;
    productsQuery = productsQuery.or(`name.ilike.${like},product_code.ilike.${like}`);
  }

  const { data: products, error: prodErr } = await productsQuery;
  if (prodErr) {
    return NextResponse.json({ error: prodErr.message }, { status: 500 });
  }

  const productIds = (products ?? []).map((p) => p.id);
  if (productIds.length === 0) {
    return NextResponse.json({ tenant: { id: tenant.id, company_name: tenant.company_name }, products: [] });
  }

  const { data: variants, error: varErr } = await supabaseAdmin
    .from("product_variants")
    .select("id, product_id, color, size, is_sale")
    .in("product_id", productIds)
    .eq("is_active", true)
    .order("color", { ascending: true })
    .order("size", { ascending: true });

  if (varErr) {
    return NextResponse.json({ error: varErr.message }, { status: 500 });
  }

  // product_id → product 매핑 (단가 계산용)
  const productMap = new Map(
    (products ?? []).map((p) => [
      p.id,
      { base_price: Number(p.base_price ?? 0), sale_price: p.sale_price == null ? null : Number(p.sale_price) },
    ])
  );

  const byProduct = new Map<
    string,
    { variant_id: string; color: string | null; size: string | null; unit_price: number }[]
  >();
  for (const v of variants ?? []) {
    const p = productMap.get(v.product_id);
    // SaleForm 패턴 그대로: variant.is_sale 이면 sale_price 우선, 없으면 base_price
    const unitPrice =
      v.is_sale && p?.sale_price != null && p.sale_price > 0
        ? p.sale_price
        : p?.base_price ?? 0;
    const list = byProduct.get(v.product_id) ?? [];
    list.push({ variant_id: v.id, color: v.color, size: v.size, unit_price: unitPrice });
    byProduct.set(v.product_id, list);
  }

  const result = (products ?? []).map((p) => ({
    product_id: p.id,
    product_name: p.name,
    product_code: p.product_code,
    category: p.category,
    variants: byProduct.get(p.id) ?? [],
  }));

  return NextResponse.json({
    tenant: { id: tenant.id, company_name: tenant.company_name },
    products: result,
  });
}
