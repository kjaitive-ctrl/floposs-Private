import { NextRequest, NextResponse } from "next/server";
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSupabaseRouteClient } from "@/lib/supabase-server";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { getValidTokenForTenant, cafe24Api, cafe24UploadImageToProduct } from "@/lib/cafe24";

const s3 = new S3Client({
  region: "auto",
  endpoint: process.env.R2_S3_ENDPOINT!,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID!,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
  },
});

// r2.dev URL에서 R2 키 추출 → S3 SDK로 이미지 Buffer 반환
async function fetchImageBuffer(r2Url: string): Promise<Buffer> {
  const base = process.env.NEXT_PUBLIC_R2_PUBLIC_BASE_URL ?? "";
  if (!base || !r2Url.startsWith(base + "/")) throw new Error(`R2 URL 형식 오류: ${r2Url}`);
  const key = r2Url.slice(base.length + 1);
  const res = await s3.send(new GetObjectCommand({ Bucket: process.env.R2_BUCKET!, Key: key }));
  const bytes = await res.Body?.transformToByteArray();
  if (!bytes) throw new Error(`R2 이미지 없음: ${key}`);
  return Buffer.from(bytes);
}

interface PushBody { productIds: string[] }

interface DbVariant {
  id: string;
  consumer_label_color: string | null;
  consumer_label_size: string | null;
  consumer_label_option3: string | null;
  is_active: boolean | null;
}
interface DbImage { url: string; sort_order: number | null; is_main: boolean | null }
interface DbMeasurement { size: string; measurements: Record<string, string | number> }
interface DbModel { name: string | null; height: number | null; weight: number | null }
interface DbShoot {
  model_id: string | null;
  worn_variant_id: string | null;
  models: DbModel | null;
}
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
  comment_data: string | null;
  cafe24_product_no: number | null;
  product_variants: DbVariant[];
  product_images: DbImage[];
  product_measurements: DbMeasurement[];
  product_shoots: DbShoot[];
}

function uniq(arr: (string | null | undefined)[]): string[] {
  return [...new Set(arr.filter((v): v is string => !!v))];
}

function materialText(raw: unknown): string {
  if (!raw) return "";
  if (typeof raw === "string") return raw;
  if (Array.isArray(raw)) return raw.map((r: { fiber?: string; pct?: number }) => `${r.fiber ?? ""} ${r.pct ?? ""}%`).join(", ");
  // 실제 저장 형식 (materialToText 와 동일 규약): { "폴리에스테르": 100, ... }
  if (typeof raw === "object") {
    return Object.entries(raw as Record<string, unknown>).map(([k, v]) => `${k} ${v}%`).join(", ");
  }
  return "";
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

const INFO_LABEL = `style="display:inline-block;background:#222;color:#fff;font-size:11px;font-weight:700;padding:3px 12px;border-radius:2px;letter-spacing:0.05em;margin-bottom:6px;"`;
const INFO_VAL   = `style="font-size:13px;color:#333;margin:0 0 14px;text-align:center;"`;

function infoRow(label: string, value: string): string {
  return `<div style="text-align:center;margin-bottom:18px;"><span ${INFO_LABEL}>${escapeHtml(label)}</span><p ${INFO_VAL}>${escapeHtml(value)}</p></div>`;
}

function buildDetailHtml(
  p: DbProduct,
  imageUrls: string[],  // cafe24 CDN URL
  fieldKeys: string[],
): string {
  const lines: string[] = [];
  const activeVariants = (p.product_variants ?? []).filter(v => v.is_active !== false);

  // 1. 멘트
  if (p.comment_data?.trim()) {
    lines.push(`<p style="font-size:14px;color:#333;text-align:center;margin-bottom:72px;white-space:pre-line;">${escapeHtml(p.comment_data.trim())}</p>`);
  }

  // 2. 상품정보 (Color / Size / 소재) — 사장 결정: 박스 테두리 없이 라벨+텍스트만
  const colors   = uniq(activeVariants.map(v => v.consumer_label_color));
  const sizes    = uniq(activeVariants.map(v => v.consumer_label_size));
  const material = materialText(p.material_composition);
  if (colors.length > 0 || sizes.length > 0 || material) {
    lines.push(`<div style="margin-bottom:24px;">`);
    if (colors.length > 0)   lines.push(infoRow("Color",  colors.join(", ")));
    if (sizes.length > 0)    lines.push(infoRow("Size",   sizes.join(" | ")));
    if (material)            lines.push(infoRow("Fabric", material));
    lines.push(`</div>`);
  }

  // 3. 착용정보 (촬영 데이터 중 첫 번째)
  const shoot = (p.product_shoots ?? [])[0];
  if (shoot) {
    const m = shoot.models;
    const wornVariant = (p.product_variants ?? []).find(v => v.id === shoot.worn_variant_id);
    const modelParts: string[] = [];
    if (m?.name)   modelParts.push(m.name);
    if (m?.height) modelParts.push(`${m.height}cm`);
    if (m?.weight) modelParts.push(`${m.weight}kg`);
    const wornParts = [wornVariant?.consumer_label_color, wornVariant?.consumer_label_size, wornVariant?.consumer_label_option3].filter(Boolean);

    if (modelParts.length > 0 || wornParts.length > 0) {
      lines.push(`<div style="margin-bottom:24px;font-size:12px;color:#555;text-align:center;">`);
      lines.push(`<span ${INFO_LABEL}>착용정보</span>`);
      if (modelParts.length > 0) lines.push(`<p style="margin:6px 0 2px;">모델: ${escapeHtml(modelParts.join(" / "))}</p>`);
      if (wornParts.length > 0)  lines.push(`<p style="margin:2px 0;">착용: ${escapeHtml(wornParts.join(" / "))}</p>`);
      lines.push(`</div>`);
    }
  }

  // 4. 상세 이미지 (등록 순서)
  for (const url of imageUrls) {
    lines.push(`<p style="margin:0;"><img src="${escapeHtml(url)}" style="max-width:100%;height:auto;display:block;" alt="" /></p>`);
  }

  // 5. 사이즈표 + 고정 안내문구
  const sizeTable = buildSizeTable(p.product_measurements ?? [], fieldKeys);
  if (sizeTable) {
    lines.push(sizeTable);
    lines.push(`<p style="font-size:11px;color:#888;margin-top:4px;">- 측정 방법에 따라 1~3cm 오차가 발생할 수 있습니다.</p>`);
  }

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

  // 토큰 취득 — 만료 감지 시 자동 refresh. 그래도 null이면 재연동 필요.
  const initialToken = await getValidTokenForTenant(tenantId);
  if (!initialToken) return NextResponse.json({ error: "카페24 미연동 또는 토큰 만료. 설정에서 카페24 재연동 해주세요." }, { status: 400 });
  let token = initialToken;

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

  // 상품 로드
  const { data: products } = await db
    .from("products")
    .select(`
      id, consumer_name, wholesale_name, category,
      regular_sale_price, consumer_price,
      wholesale_price, wholesale_price_current,
      country_of_origin, material_composition,
      comment_data, cafe24_product_no,
      product_variants(id, consumer_label_color, consumer_label_size, consumer_label_option3, is_active),
      product_images(url, sort_order, is_main),
      product_measurements(size, measurements),
      product_shoots(model_id, worn_variant_id, models(name, height, weight))
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
      // 대표 이미지 URL (첫 번째)
      const mainImageUrl = images[0].url;

      const activeVariants = (p.product_variants ?? []).filter(v => v.is_active !== false);
      const colorValues = uniq(activeVariants.map(v => v.consumer_label_color));
      const sizeValues  = uniq(activeVariants.map(v => v.consumer_label_size));
      const opt3Values  = uniq(activeVariants.map(v => v.consumer_label_option3));

      // 옵션 포맷: CSV 엑셀업로드와 동일하게 value = 파이프 구분 문자열
      // 예: { name: "색상", value: "아이보리|크림|연카키" }
      const optionList: { name: string; value: string[] }[] = [];
      if (colorValues.length > 0) optionList.push({ name: "색상", value: colorValues });
      if (sizeValues.length > 0)  optionList.push({ name: "사이즈", value: sizeValues });
      if (opt3Values.length > 0)  optionList.push({ name: "기타", value: opt3Values });

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

      const request: Record<string, unknown> = {
        product_name: productName,
        supply_product_name: (p.wholesale_name || productName).trim(),
        price,
        supply_price: supplyPrice,
        ...(retailPrice ? { retail_price: retailPrice } : {}),
        display: "F",
        selling: "T",
        ...(categoryNos.length > 0 ? { category: categoryNos.map(no => ({ category_no: no })) } : {}),
        has_option: optionList.length > 0 ? "T" : "F",
        ...(optionList.length > 0 ? {
          option_type: "C",
          options: optionList,
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

      // 이미지 업로드: 전체 이미지를 cafe24 CDN에 올리고 CDN URL로 상세 HTML 조립
      let imageWarning: string | undefined;
      if (cafe24ProductNo) {
        try {
          const cdnResults = await Promise.all(
            images.map(async (img) => {
              const imgName = img.url.split("/").pop() ?? "image.jpg";
              const buf = await fetchImageBuffer(img.url);
              const { cdnUrl } = await cafe24UploadImageToProduct(
                token.mall_id, token.access_token, cafe24ProductNo!, buf, imgName,
              );
              return cdnUrl;
            })
          );
          const cdnUrls = cdnResults.filter(Boolean) as string[];

          // CDN URL로 상세 HTML 조립 → description 필드 업데이트
          const detailHtml = buildDetailHtml(p, cdnUrls, fieldKeys);
          if (detailHtml) {
            await cafe24Api(token.mall_id, token.access_token, "PUT", `products/${cafe24ProductNo}`, {
              shop_no: 1,
              request: { description: detailHtml },
            });
          }
        } catch (imgErr) {
          imageWarning = `이미지 등록 실패: ${String(imgErr).slice(0, 500)}`;
        }
      }

      await db.from("cafe24_export_log").insert({
        retail_tenant_id: tenantId,
        product_id: p.id,
        cafe24_product_no: cafe24ProductNo,
        status: imageWarning ? "image_error" : "success",
        ...(imageWarning ? { error: imageWarning } : {}),
      }).then(() => {});

      results.push({ id: p.id, ok: true, cafe24_product_no: cafe24ProductNo ?? undefined, error: imageWarning });
    } catch (e) {
      const errStr = String(e);
      // 401 토큰 만료 → force refresh 후 재시도 없이 안내 (다음 상품부터 새 토큰 사용)
      if (errStr.includes("401")) {
        const refreshed = await getValidTokenForTenant(tenantId, true);
        if (refreshed) token = refreshed;
      }
      db.from("cafe24_export_log").insert({
        retail_tenant_id: tenantId,
        product_id: p.id,
        status: "error",
        error: errStr.slice(0, 500),
      }).then(() => {});
      results.push({ id: p.id, ok: false, error: errStr.slice(0, 1000) });
    }
  }

  return NextResponse.json({ results });
}
