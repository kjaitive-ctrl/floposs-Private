// "60%" 플랫폼 상품 업로드 엑셀 생성 — product_import_template_dropped.xlsx 기반.
// 사장 결정 (2026-07-20): 카테고리/성별/편직/소재/Variant Image URL/Image URL 1~10 = 공란,
// Vendor = "un:tyl" 고정, Variant Quantity = 9999 고정.
// 색상/사이즈 = 사전 매핑 안 함. 판매옵션명(consumer_label_*) 원본 그대로 출력 —
// 채워넣기는 Prompt 시트를 Claude 에게 주고 후속 대화에서 처리.
// 이미지는 sort_order 순으로 자동 채워 넣지 않음 (2026-07-22) — 순서 강제 방지, 수동으로 채움.

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
  "Template 시트의 Title, Variant Color 를 영어로 번역해주세요.",
  "Variant Color 는 Color Master 시트에 있는 값 중에서만 골라야 합니다. 정확히 일치하는 색상이 없으면 가장 유사한 값으로 대체해주세요 (예: 소라 → BLUE).",
];

export interface Platform60SourceProduct {
  id: string;
  consumer_name: string;
  price: number;  // 판매채널 변환(수수료 역산+환율) 완료된 값. 호출부(excelUtils) 책임.
  variants: Variant[];
}

export function buildPlatform60Rows(products: Platform60SourceProduct[]): (string | number)[][] {
  const rows: (string | number)[][] = [];
  const imageCells = Array.from({ length: 10 }, () => "");  // Image URL 1~10 — 강제 순서 없이 공란

  for (const p of products) {
    const forSale = p.variants.filter(v => v.is_for_sale !== false);
    const price = p.price;

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
        v.barcode ?? v.variant_code ?? "",          // Variant SKU (진짜 바코드 우선, 미발급이면 사람읽는코드로 대체)
        price,                                      // Variant Price
        QUANTITY_FIXED,                             // Variant Quantity
        "",                                        // Variant Image URL
        ...imageCells,                              // Image URL 1~10
      ]);
    }
  }

  return rows;
}
