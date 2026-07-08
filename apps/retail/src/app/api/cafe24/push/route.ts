import { NextRequest, NextResponse } from "next/server";
import { getSupabaseRouteClient } from "@/lib/supabase-server";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { getValidTokenForTenant, cafe24Api } from "@/lib/cafe24";

interface PushBody { productIds: string[] }

interface DbVariant {
  consumer_label_color: string | null;
  consumer_label_size: string | null;
  consumer_label_option3: string | null;
  is_active: boolean | null;
}
interface DbImage { url: string; sort_order: number | null; is_main: boolean | null }
interface DbMeasurement { size: string; measurements: Record<string, string | number> }
interface DbProduct {
  id: string;
  consumer_name: string | null;
  wholesale_name: string | null;
  category: string | null;
  regular_sale_price: number | null;
  consumer_price: number | null;
  wholesale_price: number | null;
  wholesale_price_current: string | null;
  country_of_origin: string | null;
  material_composition: unknown;
  cafe24_product_no: number | null;
  product_variants: DbVariant[];
  product_images: DbImage[];
  product_measurements: DbMeasurement[];
}

function uniq(arr: (string | null | undefined)[]): string[] {
  return [...new Set(arr.filter((v): v is string => !!v))];
}

function materialText(raw: unknown): string {
  if (!raw) return "";
  if (typeof raw === "string") return raw;
  if (Array.isArray(raw)) return raw.map((r: { fiber?: string; pct?: number }) => `${r.fiber ?? ""} ${r.pct ?? ""}%`).join(", ");
  return String(raw);
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

const TD = `style="border:1px solid #e0e0e0;padding:6px 10px;text-align:center;font-size:12px;"`;
const TH = `style="border:1px solid #e0e0e0;padding:6px 10px;text-align:center;font-size:12px;background:#f8f8f8;font-weight:600;"`;

function buildSizeTable(measurements: DbMeasurement[], fieldKeys: string[]): string {
  if (measurements.length === 0 || fieldKeys.length === 0) return "";
  // 값이 하나라도 있는 row만 포함
  const rows = measurements
    .filter(m => fieldKeys.some(k => m.measurements[k] != null && m.measurements[k] !== ""))
    .sort((a, b) => a.size.localeCompare(b.size));
  if (rows.length === 0) return "";

  const headers = ["사이즈", ...fieldKeys].map(k => `<th ${TH}>${escapeHtml(k)}</th>`).join("");
  const trs = rows.map(m => {
    const cells = [
      `<td ${TD}><strong>${escapeHtml(m.size)}</strong></td>`,
      ...fieldKeys.map(k => `<td ${TD}>${escapeHtml(String(m.measurements[k] ?? "—"))}</td>`),
    ].join("");
    return `<tr>${cells}</tr>`;
  }).join("");

  return `<table style="width:100%;border-collapse:collapse;margin:16px 0;">\n<thead><tr>${headers}</tr></thead>\n<tbody>${trs}</tbody>\n</table>`;
}

function buildDetailHtml(
  p: DbProduct,
  sortedImages: DbImage[],
  fieldKeys: string[],
): string {
  const lines: string[] = [];

  // 상세 이미지 (전체)
  for (const img of sortedImages) {
    lines.push(`<p><img src="${escapeHtml(img.url)}" style="max-width:100%;display:block;" alt="" /></p>`);
  }

  // 사이즈표
  const sizeTable = buildSizeTable(p.product_measurements ?? [], fieldKeys);
  if (sizeTable) lines.push(sizeTable);

  // 소재/제조국
  const origin = escapeHtml(p.country_of_origin ?? "");
  const material = escapeHtml(materialText(p.material_composition));
  if (origin)   lines.push(`<p>제조국: ${origin}</p>`);
  if (material) lines.push(`<p>혼용률: ${material}</p>`);

  lines.push(`<p style="font-size:11px;color:#888;margin-top:24px;">* 모니터 환경에 따라 색상이 다소 다를 수 있습니다.<br>* 수작업 측정으로 1~3cm 오차가 있을 수 있습니다.</p>`);

  return lines.join("\n");
}

// POST /api/cafe24/push — 선택된 상품 카페24로 전송.
// body: { productIds: string[] }
// - cafe24_product_no 없음 → POST create
// - cafe24_product_no 있음 → PUT update
// - 이미지 0장 → skip + error 반환
export async function POST(req: NextRequest) {
  const supabase = await getSupabaseRouteClient();
  const { data: { user } } = await supabase.auth.getUser();
  const tenantId = (user?.app_metadata as { tenant_id?: string } | undefined)?.tenant_id;
  if (!tenantId) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });

  let body: PushBody;
  try { body = await req.json() as PushBody; }
  catch { return NextResponse.json({ error: "잘못된 요청 body" }, { status: 400 }); }
  const { productIds } = body;
  if (!Array.isArray(productIds) || productIds.length === 0)
    return NextResponse.json({ error: "productIds 필요" }, { status: 400 });
  if (productIds.length > 30)
    return NextResponse.json({ error: "한 번에 최대 30개" }, { status: 400 });

  const token = await getValidTokenForTenant(tenantId);
  if (!token) return NextResponse.json({ error: "카페24 미연동 또는 토큰 만료" }, { status: 400 });

  const db = supabaseAdmin;

  // 카테고리 매핑 + 공통 카테고리 로드
  const [{ data: mappingRows }, { data: tenantRow }] = await Promise.all([
    db.from("tenant_category_mapping")
      .select("retail_category, cafe24_category_no")
      .eq("retail_tenant_id", tenantId),
    db.from("tenants")
      .select("cafe24_global_category_nos")
      .eq("id", tenantId)
      .single(),
  ]);
  const categoryMap = new Map<string, number>(
    (mappingRows ?? []).map((m: { retail_category: string; cafe24_category_no: number }) =>
      [m.retail_category, m.cafe24_category_no]
    )
  );
  const globalCategoryNos: number[] = (tenantRow as { cafe24_global_category_nos?: number[] | null } | null)
    ?.cafe24_global_category_nos ?? [];

  // 상품 로드 (measurements 포함)
  const { data: products } = await db
    .from("products")
    .select(`
      id, consumer_name, wholesale_name, category,
      regular_sale_price, consumer_price,
      wholesale_price, wholesale_price_current,
      country_of_origin, material_composition,
      cafe24_product_no,
      product_variants(consumer_label_color, consumer_label_size, consumer_label_option3, is_active),
      product_images(url, sort_order, is_main),
      product_measurements(size, measurements)
    `)
    .in("id", productIds)
    .eq("tenant_id", tenantId);

  // 카테고리별 사이즈 field_keys 로드 (상품들의 카테고리 목록 기준)
  const categories = [...new Set((products ?? [])
    .map(p => (p as unknown as DbProduct).category)
    .filter((c): c is string => !!c))];
  const { data: templateRows } = categories.length > 0
    ? await db.from("measurement_templates")
        .select("category, field_keys")
        .in("category", categories)
    : { data: [] };
  const templateMap = new Map<string, string[]>(
    (templateRows ?? []).map((t: { category: string; field_keys: string[] }) => [t.category, t.field_keys])
  );

  type PushResult = { id: string; ok: boolean; cafe24_product_no?: number; error?: string };
  const results: PushResult[] = [];

  for (const raw of (products ?? [])) {
    const p = raw as unknown as DbProduct;
    try {
      // 이미지 없으면 차단
      const images = (p.product_images ?? []).sort((a, b) => {
        if (a.is_main && !b.is_main) return -1;
        if (!a.is_main && b.is_main) return 1;
        return (a.sort_order ?? 0) - (b.sort_order ?? 0);
      });
      if (images.length === 0) {
        results.push({ id: p.id, ok: false, error: "이미지 없음 — 전송 차단" });
        continue;
      }
      const mainImageUrl = images[0].url;
      // 갤러리 추가 이미지 (2번째~)
      const additionalImages = images.slice(1).map(img => ({ image: img.url }));

      const activeVariants = (p.product_variants ?? []).filter(v => v.is_active !== false);
      const colorValues = uniq(activeVariants.map(v => v.consumer_label_color));
      const sizeValues  = uniq(activeVariants.map(v => v.consumer_label_size));
      const opt3Values  = uniq(activeVariants.map(v => v.consumer_label_option3));

      const optionList: { option_name: string; option_value: { option_value_name: string }[] }[] = [];
      if (colorValues.length > 0) optionList.push({ option_name: "색상", option_value: colorValues.map(v => ({ option_value_name: v })) });
      if (sizeValues.length > 0)  optionList.push({ option_name: "사이즈", option_value: sizeValues.map(v => ({ option_value_name: v })) });
      if (opt3Values.length > 0)  optionList.push({ option_name: "기타", option_value: opt3Values.map(v => ({ option_value_name: v })) });

      // 카테고리 조합: 상품별 매핑 + 공통 슬롯 (중복 제거)
      const mappedNo = categoryMap.get(p.category ?? "");
      const categoryNos = [...new Set([
        ...(mappedNo ? [mappedNo] : []),
        ...globalCategoryNos,
      ])];

      const productName = (p.consumer_name || p.wholesale_name || "").trim() || "상품명 미입력";
      const price = String(p.regular_sale_price ? Math.round(Number(p.regular_sale_price)) : 0);
      const retailPrice = p.consumer_price ? String(Math.round(Number(p.consumer_price))) : undefined;
      const supplyPrice = p.wholesale_price_current
        ? String(Math.round(Number(p.wholesale_price_current)))
        : p.wholesale_price
        ? String(Math.round(Number(p.wholesale_price)))
        : "0";

      const fieldKeys = templateMap.get(p.category ?? "") ?? [];
      const detailHtml = buildDetailHtml(p, images, fieldKeys);

      const request: Record<string, unknown> = {
        product_name: productName,
        supply_product_name: (p.wholesale_name || productName).trim(),
        price,
        supply_price: supplyPrice,
        ...(retailPrice ? { retail_price: retailPrice } : {}),
        display: "F",
        selling: "T",
        detail_image: mainImageUrl,
        list_image: mainImageUrl,
        small_image: mainImageUrl,
        ...(additionalImages.length > 0 ? { additional_images: additionalImages } : {}),
        ...(categoryNos.length > 0 ? { category: categoryNos.map(no => ({ category_no: no })) } : {}),
        ...(detailHtml ? { detail_content: detailHtml } : {}),
        ...(optionList.length > 0 ? {
          options: { has_option: "T", option_type: "T", option_list: optionList },
        } : {}),
      };

      let cafe24ProductNo = p.cafe24_product_no;

      if (cafe24ProductNo) {
        await cafe24Api(token.mall_id, token.access_token, "PUT", `products/${cafe24ProductNo}`, {
          shop_no: 1, request,
        });
      } else {
        const res = await cafe24Api<{ product: { product_no: number } }>(
          token.mall_id, token.access_token, "POST", "products", { shop_no: 1, request }
        );
        cafe24ProductNo = res.product.product_no;
        await db.from("products")
          .update({ cafe24_product_no: cafe24ProductNo })
          .eq("id", p.id);
      }

      await db.from("cafe24_export_log").insert({
        retail_tenant_id: tenantId,
        product_id: p.id,
        cafe24_product_no: cafe24ProductNo,
        status: "success",
      }).then(() => {});

      results.push({ id: p.id, ok: true, cafe24_product_no: cafe24ProductNo ?? undefined });
    } catch (e) {
      db.from("cafe24_export_log").insert({
        retail_tenant_id: tenantId,
        product_id: p.id,
        status: "error",
        error: String(e).slice(0, 500),
      }).then(() => {});
      results.push({ id: p.id, ok: false, error: String(e).slice(0, 200) });
    }
  }

  return NextResponse.json({ results });
}
