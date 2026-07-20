// "60%" 플랫폼 상품 업로드 엑셀 생성 — product_import_template_dropped.xlsx 기반.
// 사장 결정 (2026-07-20): 카테고리/성별/편직/소재/Variant Image URL = 공란,
// Vendor = "un:tyl" 고정, Variant Quantity = 9999 고정.
// 색상/사이즈 = 사전 매핑 안 함. 판매옵션명(consumer_label_*) 원본 그대로 출력 —
// 채워넣기는 Prompt 시트를 Claude 에게 주고 후속 대화에서 처리.

import type { Variant } from "@/lib/samplesUtils";

export const TEMPLATE_URL = "/templates/60_product_import_template.xlsx";
export const TEMPLATE_SHEET_NAME = "Template";
export const PROMPT_SHEET_NAME = "Prompt";

export const TEMPLATE_HEADERS = [
  "Title", "Description", "Gender", "Vendor", "Item Category", "Knitting",
  "Material Name", "Material Percent",
  "Variant Size", "Variant Color", "Variant SKU", "Variant Price", "Variant Quantity",
  "Variant Image URL",
  "Image URL 1", "Image URL 2", "Image URL 3", "Image URL 4", "Image URL 5",
  "Image URL 6", "Image URL 7", "Image URL 8", "Image URL 9", "Image URL 10",
] as const;

export const VENDOR_FIXED = "un:tyl";
export const QUANTITY_FIXED = 9999;

// Claude 에게 이 파일을 다시 줄 때 그대로 붙여넣을 지침. Prompt 시트 A열에 한 줄씩 들어감.
export const PROMPT_LINES: string[] = [
  "이 파일은 플로포스 retail 상품을 '60%' 플랫폼 업로드 양식으로 추출한 것입니다.",
  "Template 시트 = SKU(옵션) 단위로 한 줄. 같은 상품이 색상/사이즈별로 여러 줄 반복됩니다.",
  "",
  "아래 공란 컬럼을 채워주세요. 값은 반드시 이 파일의 해당 Master 시트(Gender Master / Item Category Master / Knitting Master / Size Master / Color Master)에 있는 값 중에서만 골라야 합니다.",
  "",
  "1) Title — 지금 한글 상품명이 그대로 들어있습니다. 영어로 번역해주세요. 브랜드명/시리즈명 같은 고유명사는 억지로 번역하지 말고 그대로 로마자 표기하고, 소재·핏·카테고리 단어(코튼/트레이닝/버뮤다팬츠 등)는 뜻으로 번역해주세요.",
  "2) Variant Size / Variant Color — 지금 한글 판매옵션명이 그대로 들어있습니다. Size Master / Color Master 목록 중 가장 가까운 값으로 바꿔주세요. 축약어·오타(예: '검', '아', '하하', 'dd')는 앞뒤 다른 행 패턴을 보고 유추하고, 정말 애매하면 Color Master의 'OTHER'를 쓰세요.",
  "3) Gender — Gender Master(MEN/WOMEN/UNISEX) 중에서 상품명과 옵션 구성을 보고 판단해서 채워주세요. 판단 근거가 부족하면 UNISEX.",
  "4) Item Category — Item Category Master 중에서 상품명을 보고 가장 가까운 카테고리로 채워주세요.",
  "5) Knitting — Knitting Master(KNIT/WOVEN/Apparel 등) 중에서 상품명·소재로 추정해서 채워주세요. 확신 없으면 Apparel.",
  "6) Material Name / Material Percent — 상품명에 소재가 명시돼 있으면 채우고, 알 수 없으면 공란으로 두세요.",
  "",
  "건드리면 안 되는 것: Vendor(un:tyl)와 Variant Quantity(9999)는 이미 고정값이 채워져 있습니다. Variant SKU, Variant Price, Image URL 들도 건드리지 마세요.",
  "작업 끝나면 이 파일과 같은 구조(.xlsx, Template 시트 컬럼/행 순서 그대로)로 돌려주세요.",
];

export interface Platform60SourceProduct {
  id: string;
  consumer_name: string;
  price: number;  // 판매채널 변환(수수료 역산+환율) 완료된 값. 호출부(excelUtils) 책임.
  variants: Variant[];
  images: string[];  // sort_order 순 R2 public URL, 최대 10장 사용
}

export function buildPlatform60Rows(products: Platform60SourceProduct[]): (string | number)[][] {
  const rows: (string | number)[][] = [];

  for (const p of products) {
    const forSale = p.variants.filter(v => v.is_for_sale !== false);
    const price = p.price;
    const images = p.images.slice(0, 10);
    const imageCells = Array.from({ length: 10 }, (_, i) => images[i] ?? "");

    for (const v of forSale) {
      rows.push([
        p.consumer_name,                          // Title
        "",                                        // Description
        "",                                        // Gender
        VENDOR_FIXED,                              // Vendor
        "",                                        // Item Category
        "",                                        // Knitting
        "",                                        // Material Name
        "",                                        // Material Percent
        (v.consumer_label_size ?? "").trim(),       // Variant Size (원본 그대로)
        (v.consumer_label_color ?? "").trim(),      // Variant Color (원본 그대로)
        v.variant_code ?? "",                      // Variant SKU
        price,                                      // Variant Price
        QUANTITY_FIXED,                             // Variant Quantity
        "",                                        // Variant Image URL
        ...imageCells,                              // Image URL 1~10
      ]);
    }
  }

  return rows;
}
