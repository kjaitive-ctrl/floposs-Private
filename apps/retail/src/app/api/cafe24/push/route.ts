import { NextRequest, NextResponse } from "next/server";
import sharp from "sharp";
import { getSupabaseRouteClient } from "@/lib/supabase-server";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { getValidTokenForTenant, cafe24Api, cafe24UploadImageToProduct } from "@/lib/cafe24";
import { getObjectBuffer, keyFromPublicUrl } from "@/lib/r2";
import { buildThumbnailAsset } from "@/lib/thumbnailGif";

// R2 공개 URL → key 역추출 후 Buffer 반환
async function fetchImageBuffer(r2Url: string): Promise<Buffer> {
  const key = keyFromPublicUrl(r2Url);
  if (!key) throw new Error(`R2 URL 형식 오류: ${r2Url}`);
  return getObjectBuffer(key);
}

// 상세/기타 이미지는 원본 그대로(무제한 해상도) 카페24에 올라가던 문제 —
// 큰 원본 1장이 카페24 업로드 API 자체를 실패시키면(WAF/사이즈 제한) Promise.all 전체가
// 죽어 나머지 이미지도 다 같이 실패하고 상세페이지도 아예 안 만들어짐. 안전 상한선으로 사전 축소.
const DETAIL_IMG_MAX_BYTES = 2 * 1024 * 1024; // 2MB 안전 마진
const DETAIL_IMG_EDGE_CANDIDATES = [2000, 1600, 1200, 900]; // 긴 변 기준 순차 축소

async function capImageForCafe24(buf: Buffer): Promise<Buffer> {
  if (buf.length <= DETAIL_IMG_MAX_BYTES) return buf;
  let last = buf;
  for (const edge of DETAIL_IMG_EDGE_CANDIDATES) {
    last = await sharp(buf)
      .resize({ width: edge, height: edge, fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: 85 })
      .toBuffer();
    if (last.length <= DETAIL_IMG_MAX_BYTES) return last;
  }
  return last; // 최소 후보로도 초과 — 그래도 원본보다 작은 최후 결과 반환
}

interface PushBody { productIds: string[] }

interface DbVariant {
  id: string;
  consumer_label_color: string | null;
  consumer_label_size: string | null;
  consumer_label_option3: string | null;
  is_active: boolean | null;
}
interface DbImage { url: string; sort_order: number | null; is_main: boolean | null; image_type: string | null }
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

const QUALITY_GUARANTEE_TEXT = "소비자보호에 관한 법률로 규정되어있는 소비자 청약 철회 가능범위에 해당되는 경우";

// 원산지 표기 정규화 — 자유입력값을 괄호 없는 표준 문구로 치환
function formatOrigin(raw: string | null): string {
  const v = (raw ?? "").trim();
  if (!v) return "-";
  if (v.includes("내수")) return "대한민국";
  if (v.includes("중국")) return "중국";
  return "기타국가";
}

function piRow(label: string, value: string, isLast = false): string {
  const borderBottom = isLast ? "border-bottom:1px solid #e5e5e5;" : "";
  const labelStyle = `style="width:120px;padding:8px 12px;border-top:1px solid #e5e5e5;${borderBottom}color:#888;font-size:12px;background:#fafafa;"`;
  const valueStyle = `style="padding:8px 12px;border-top:1px solid #e5e5e5;${borderBottom}color:#333;font-size:12px;"`;
  return `<tr><td ${labelStyle}>${escapeHtml(label)}</td><td ${valueStyle}>${escapeHtml(value)}</td></tr>`;
}

function buildDetailHtml(
  p: DbProduct,
  imageUrls: string[],  // cafe24 CDN URL
  fieldKeys: string[],
  companyName: string,  // tenants.company_name — "제조사" 표기용
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
    lines.push(`<div style="font-size:11px;color:#888;margin-top:4px;line-height:1.6;">
<p style="margin:2px 0;">1. 사이즈는 단면기준으로 측정됩니다.</p>
<p style="margin:2px 0;">2. 사이즈는 측정 방법과 생산시차에 따라 약 1~3cm 정도 오차가 있을 수 있습니다.</p>
<p style="margin:2px 0;">3. 제품색상은 사용자의 모니터의 해상도에 따라 실제 색상과 다소 차이가 있을 수 있습니다.</p>
<p style="margin:2px 0;">4. 조명이나 환경으로 인해 제품 색상이 정확하지 않을 수 있습니다. 디테일컷의 색상이 실제 상품 색상과 가장 비슷합니다.</p>
</div>`);
  }

  // 6. PRODUCT INFO — 상품명/소재/제조사/원산지/품질보증기준. 제조사 = 테넌트 상호 + "협력업체".
  const piProductName = (p.consumer_name || p.wholesale_name || "").trim() || "상품명 미입력";
  const piMaterial = material || "-";
  const piManufacturer = companyName ? `${companyName} 협력업체` : "-";
  const piOrigin = formatOrigin(p.country_of_origin);
  lines.push(`<div style="margin-top:48px;">
<p style="text-align:center;font-size:13px;font-weight:700;letter-spacing:0.15em;color:#222;margin-bottom:14px;">PRODUCT INFO</p>
<table style="width:100%;border-collapse:collapse;">
${piRow("상품명", piProductName)}
${piRow("소재", piMaterial)}
${piRow("제조사", piManufacturer)}
${piRow("원산지", piOrigin)}
${piRow("품질보증기준", QUALITY_GUARANTEE_TEXT, true)}
</table>
</div>`);

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
      .select("cafe24_global_category_nos, company_name")
      .eq("id", tenantId)
      .single(),
  ]);
  const companyName = (tenantRow as { company_name?: string | null } | null)?.company_name?.trim() || "";
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
      product_images(url, sort_order, is_main, image_type),
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

      // 카테고리(상품분류) 진열 반영 — products 생성/수정 body 의 category 필드만으로는
      // 카페24 관리자 "상품분류" 화면에 실제 진열 반영이 안 되는 것으로 확인됨. 카페24 REST 리소스
      // 설계상 상품-카테고리 연결은 별도 리소스(categories/{category_no}/products, display_group=진열영역)
      // 로 관리되므로, 카테고리별로 순차 등록 호출해서 확정.
      let imageWarning: string | undefined;
      if (cafe24ProductNo && categoryNos.length > 0) {
        for (const categoryNo of categoryNos) {
          try {
            await cafe24Api(token.mall_id, token.access_token, "POST", `categories/${categoryNo}/products`, {
              shop_no: 1,
              request: { product_no: [cafe24ProductNo], display_group: 1 },
            });
          } catch (catErr) {
            const msg = `카테고리(${categoryNo}) 등록 실패: ${String(catErr).slice(0, 200)}`;
            imageWarning = imageWarning ? `${imageWarning}; ${msg}` : msg;
          }
        }
      }

      // 이미지 업로드: 전체 이미지를 cafe24 CDN에 올리고 CDN URL로 상세 HTML 조립.
      // 순차 처리 — 병렬로 한꺼번에 쏘면 카페24 쪽 동시요청/버스트 제한에 걸려 뒷부분이 HTML 에러로
      // 튕기는 사례가 있었음. 이미지 1장 실패해도 나머지 성공한 이미지만으로 상세페이지는 반드시 생성.
      if (cafe24ProductNo) {
        const cdnUrls: string[] = [];
        const failReasons: string[] = [];
        for (const img of images) {
          try {
            const imgName = img.url.split("/").pop() ?? "image.jpg";
            const buf = await fetchImageBuffer(img.url);
            const capped = await capImageForCafe24(buf);
            const { cdnUrl } = await cafe24UploadImageToProduct(
              token.mall_id, token.access_token, cafe24ProductNo!, capped, imgName,
            );
            if (cdnUrl) cdnUrls.push(cdnUrl);
          } catch (imgErr) {
            failReasons.push(String(imgErr).slice(0, 300));
          }
        }
        if (failReasons.length > 0) {
          const msg = `이미지 ${failReasons.length}/${images.length}장 업로드 실패 (첫 실패: ${failReasons[0]})`;
          imageWarning = imageWarning ? `${imageWarning}; ${msg}` : msg;
        }

        try {
          // CDN URL로 상세 HTML 조립 → description 필드 업데이트 (일부 이미지 실패해도 진행)
          const detailHtml = buildDetailHtml(p, cdnUrls, fieldKeys, companyName);
          if (detailHtml) {
            await cafe24Api(token.mall_id, token.access_token, "PUT", `products/${cafe24ProductNo}`, {
              shop_no: 1,
              request: { description: detailHtml },
            });
          }
        } catch (descErr) {
          const msg = `상세페이지 등록 실패: ${String(descErr).slice(0, 500)}`;
          imageWarning = imageWarning ? `${imageWarning}; ${msg}` : msg;
        }

        // 대표이미지(썸네일) 확정 — image_type='thumbnail' 이미지로 GIF(2장+)/단일이미지(1장) 합성 후
        // 마지막에 순차 업로드하여 대표이미지 슬롯을 확정. 위 상세이미지 루프도 동일 "대표이미지" 엔드포인트를
        // 호출하므로(카페24 사양), 순서상 가장 마지막에 실행되는 이 호출이 실제 노출되는 대표이미지가 된다.
        try {
          const thumbUrls = images
            .filter(img => img.image_type === "thumbnail")
            .map(img => img.url);
          const asset = await buildThumbnailAsset(thumbUrls);
          if (asset) {
            await cafe24UploadImageToProduct(
              token.mall_id, token.access_token, cafe24ProductNo, asset.buffer, `thumbnail.${asset.ext}`,
            );
          }
        } catch (thumbErr) {
          const msg = `썸네일 생성 실패: ${String(thumbErr).slice(0, 400)}`;
          imageWarning = imageWarning ? `${imageWarning}; ${msg}` : msg;
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
