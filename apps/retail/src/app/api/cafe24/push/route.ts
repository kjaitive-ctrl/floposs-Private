import { NextRequest, NextResponse } from "next/server";
import sharp from "sharp";
import { getSupabaseRouteClient } from "@/lib/supabase-server";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { getValidTokenForTenant, cafe24Api, cafe24UploadImageToProduct, type ValidToken } from "@/lib/cafe24";
import { getObjectBuffer, keyFromPublicUrl } from "@/lib/r2";
import { buildThumbnailAsset } from "@/lib/thumbnailGif";
import { buildDetailHtml, sortedActiveVariants, uniq, type DetailProduct } from "@/lib/productDetailHtml";

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

// ⚠️ 카페24 업로드(products/{no}/images)는 반드시 1장씩 순차. 이 엔드포인트는 "상품 대표이미지 교체"라
// 응답의 detail_image 가 "방금 올린 파일"이 아니라 "상품의 현재 대표이미지"를 돌려줌 — 2장 동시로 쏘면
// 둘 다 나중에 끝난 쪽 URL을 받아 상세페이지에 같은 이미지가 2번 박히고 다른 1장은 빠졌음(2026-07~10 실측:
// 중복이 항상 동시처리 묶음 안의 짝). 속도는 R2 다운로드+리사이즈를 다음 장 업로드와 겹쳐서 확보.

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

interface DbImage { url: string; sort_order: number | null; is_main: boolean | null; image_type: string | null }
interface DbProduct extends DetailProduct {
  id: string;
  category: string | null;
  regular_sale_price: number | null;
  consumer_price: number | null;
  wholesale_price: number | null;
  wholesale_price_current: string | null;
  cafe24_product_no: number | null;
  product_images: DbImage[];
}

// 상품별 이미지 순차 업로드+리사이징 때문에 다건 전송 시 오래 걸림 — Vercel 기본 제한(10~60초대)
// 걸리지 않도록 여유 확보 (Pro 플랜 기준 최대 300초).
export const maxDuration = 300;

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

  // 다건 전송은 순차 처리라 시간이 걸림 — 처음에 유효했던 token이 배치 도중 실제로 만료될 수 있음.
  // 호출마다 이걸로 감싸서 401 나오면 그 즉시 refresh 후 같은 호출을 재시도(이 상품도 살림).
  // 이미지 업로드를 동시성 2로 돌리면서 두 요청이 하필 같은 순간 401을 받을 수 있음 — refresh_token이
  // 회전(rotate)되는 경우 동시에 두 번 refresh 시도하면 나중 것이 "이미 쓰인 refresh_token"으로 실패할
  // 수 있어, 이미 진행 중인 refresh가 있으면 그 Promise를 공유해서 실제 refresh 호출은 한 번만 나가게 함.
  let refreshInFlight: Promise<ValidToken | null> | null = null;
  const callCafe24 = async <T,>(fn: (t: ValidToken) => Promise<T>): Promise<T> => {
    try {
      return await fn(token);
    } catch (e) {
      if (String(e).includes("401")) {
        if (!refreshInFlight) {
          refreshInFlight = getValidTokenForTenant(tenantId, true).finally(() => { refreshInFlight = null; });
        }
        const refreshed = await refreshInFlight;
        if (refreshed) {
          token = refreshed;
          return await fn(refreshed);
        }
      }
      throw e;
    }
  };

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
      comment_data, detail_options, cafe24_product_no,
      product_variants(id, consumer_label_color, consumer_label_size, consumer_label_option3, is_active, sort_order),
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
      // 상세페이지 본문(섹션4 "상세 이미지")에는 썸네일용 이미지가 섞이면 안 됨 —
      // 썸네일은 대표이미지 슬롯 전용(하단 별도 로직), 본문엔 detail/etc 타입만.
      const detailImages = images.filter(img => img.image_type !== "thumbnail");
      const activeVariants = sortedActiveVariants(p);
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
        await callCafe24(t => cafe24Api(t.mall_id, t.access_token, "PUT", `products/${cafe24ProductNo}`, {
          shop_no: 1, request,
        }));
      } else {
        const res = await callCafe24(t => cafe24Api<{ product: { product_no: number } }>(
          t.mall_id, t.access_token, "POST", "products", { shop_no: 1, request }
        ));
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
            await callCafe24(t => cafe24Api(t.mall_id, t.access_token, "POST", `categories/${categoryNo}/products`, {
              shop_no: 1,
              request: { product_no: [cafe24ProductNo], display_group: 1 },
            }));
          } catch (catErr) {
            const msg = `카테고리(${categoryNo}) 등록 실패: ${String(catErr).slice(0, 200)}`;
            imageWarning = imageWarning ? `${imageWarning}; ${msg}` : msg;
          }
        }
      }

      // 이미지 업로드: 전체 이미지를 cafe24 CDN에 올리고 CDN URL로 상세 HTML 조립.
      // 카페24 업로드는 1장씩 순차(위 ⚠️ 참고), 다음 장의 R2 다운로드+리사이즈는 현재 장 업로드와 동시 진행.
      // 이미지 1장 실패해도 나머지 성공한 이미지만으로 상세페이지는 반드시 생성.
      if (cafe24ProductNo) {
        const cdnUrls: string[] = [];
        const failReasons: string[] = [];

        const prepare = (img: DbImage) => fetchImageBuffer(img.url)
          .then(capImageForCafe24)
          .then(buf => ({ ok: true as const, buf }), (err: unknown) => ({ ok: false as const, err }));
        let pending = detailImages.length > 0 ? prepare(detailImages[0]) : null;

        for (let i = 0; i < detailImages.length; i++) {
          const prepared = await pending!;
          pending = i + 1 < detailImages.length ? prepare(detailImages[i + 1]) : null;
          if (!prepared.ok) {
            failReasons.push(String(prepared.err).slice(0, 300));
            continue;
          }
          try {
            const imgName = detailImages[i].url.split("/").pop() ?? "image.jpg";
            const { cdnUrl } = await callCafe24(t => cafe24UploadImageToProduct(
              t.mall_id, t.access_token, cafe24ProductNo!, prepared.buf, imgName,
            ));
            // 안전망: 같은 URL이 또 오면 = 응답이 방금 올린 파일이 아님 → 상세에 중복 박지 않고 경고로 남김
            if (cdnUrl && cdnUrls.includes(cdnUrl)) {
              failReasons.push(`${imgName}: 카페24가 이전 이미지와 같은 URL 반환 (중복 제외)`);
            } else if (cdnUrl) {
              cdnUrls.push(cdnUrl);
            }
          } catch (e) {
            failReasons.push(String(e).slice(0, 300));
          }
        }

        if (failReasons.length > 0) {
          const msg = `이미지 ${failReasons.length}/${detailImages.length}장 업로드 실패 (첫 실패: ${failReasons[0]})`;
          imageWarning = imageWarning ? `${imageWarning}; ${msg}` : msg;
        }

        try {
          // CDN URL로 상세 HTML 조립 → description 필드 업데이트 (일부 이미지 실패해도 진행)
          const detailHtml = buildDetailHtml(p, cdnUrls, fieldKeys, companyName);
          if (detailHtml) {
            await callCafe24(t => cafe24Api(t.mall_id, t.access_token, "PUT", `products/${cafe24ProductNo}`, {
              shop_no: 1,
              request: { description: detailHtml },
            }));
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
            await callCafe24(t => cafe24UploadImageToProduct(
              t.mall_id, t.access_token, cafe24ProductNo!, asset.buffer, `thumbnail.${asset.ext}`,
            ));
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
      // 401은 callCafe24 안에서 이미 refresh+재시도까지 마친 뒤에도 실패한 경우
      // (refresh_token 자체 만료 등) — 여기선 로깅만.
      const errStr = String(e);
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
