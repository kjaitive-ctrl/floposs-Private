"use client";

// 엑셀 양식 다운로드 / 일괄 업로드 / 상품목록 export — 모두 클라이언트 측 SheetJS 처리.
// 양식 수정 시 UPLOAD_COLUMNS / EXPORT_HEADERS / 매핑 로직 만 손보면 됨.

import * as XLSX from "xlsx";
import { supabase } from "@/lib/supabase";
import { cartesian, split, textToMaterial } from "@/lib/samplesUtils";
import type { Variant } from "@/lib/samplesUtils";
import {
  TEMPLATE_URL, TEMPLATE_HEADERS, TEMPLATE_SHEET_NAME, PROMPT_SHEET_NAME, PROMPT_LINES,
  buildPlatform60Rows, type Platform60SourceProduct,
} from "@/lib/platform60";
import { convertToPlatformPrice, type Platform, type FxRates } from "@/lib/platformPricing";

// ────────────────────────────────────────────
// 일괄 등록 양식
// ────────────────────────────────────────────
const UPLOAD_HEADERS = [
  "공급상품명", "공급사", "카테고리", "공급가", "할인가",
  "옵션1(색상)", "옵션2(사이즈)", "옵션3",
  "메모", "입고일", "반납기한", "제조국", "혼용율",
] as const;

export function downloadUploadTemplate() {
  const example = [
    "샘플원피스A", "도매사ABC", "원피스", 12000, 9500,
    "블랙, 화이트", "S, M, L", "",
    "샘플 메모 예시", "2026-05-25", "2026-06-08", "한국", "면 70, 폴리 30",
  ];
  const ws = XLSX.utils.aoa_to_sheet([Array.from(UPLOAD_HEADERS), example]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "상품등록양식");
  XLSX.writeFile(wb, "상품_일괄등록_양식.xlsx");
}

type UploadRow = Record<string, string | number | null>;

export async function parseUploadFile(file: File): Promise<UploadRow[]> {
  const buf = await file.arrayBuffer();
  const wb = XLSX.read(buf, { type: "array", cellDates: true });
  const ws = wb.Sheets[wb.SheetNames[0]];
  return XLSX.utils.sheet_to_json<UploadRow>(ws, { defval: null, raw: false });
}

export interface BatchInsertResult {
  success: number;
  failed: number;
  errors: string[];
}

function pickStr(r: UploadRow, key: string): string {
  const v = r[key];
  return v == null ? "" : String(v).trim();
}
function pickNum(r: UploadRow, key: string): number | null {
  const v = r[key];
  if (v == null || v === "") return null;
  const n = Number(String(v).replace(/[^0-9.-]/g, ""));
  return isNaN(n) ? null : n;
}
function pickDate(r: UploadRow, key: string): string {
  const v = r[key];
  if (!v) return "";
  // "2026-05-25", "2026/05/25", Date 객체 모두 처리
  const s = String(v).slice(0, 10).replace(/\//g, "-");
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : "";
}

export async function batchInsertProducts(
  tenantId: string,
  rows: UploadRow[],
): Promise<BatchInsertResult> {
  let success = 0;
  let failed = 0;
  const errors: string[] = [];

  const { count: existing } = await supabase.from("products")
    .select("*", { count: "exact", head: true })
    .eq("tenant_id", tenantId);
  let nextNum = (existing ?? 0) + 1;

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const wholesaleName = pickStr(r, "공급상품명");
    if (!wholesaleName) {
      failed++;
      errors.push(`${i + 2}행: 공급상품명 누락 — skip`);
      continue;
    }

    const productCode = `R-${String(nextNum).padStart(3, "0")}`;
    nextNum++;

    const o1 = split(pickStr(r, "옵션1(색상)"));
    const o2 = split(pickStr(r, "옵션2(사이즈)"));
    const o3 = split(pickStr(r, "옵션3"));

    const today = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Seoul" });
    const launchDate = pickDate(r, "입고일") || today;
    const returnDeadline = pickDate(r, "반납기한") || (() => {
      const d = new Date(launchDate);
      d.setDate(d.getDate() + 14);
      return d.toISOString().slice(0, 10);
    })();

    const { data: pData, error: pErr } = await supabase.from("products").insert({
      tenant_id: tenantId,
      product_code: productCode,
      name: wholesaleName,
      wholesale_name: wholesaleName,
      wholesale_supplier: pickStr(r, "공급사") || null,
      category: pickStr(r, "카테고리") || null,
      wholesale_price: pickNum(r, "공급가"),
      wholesale_discount_price: pickNum(r, "할인가"),
      status: "sample_received",
      launch_date: launchDate,
      return_deadline: returnDeadline,
      description: pickStr(r, "메모") || null,
      country_of_origin: pickStr(r, "제조국") || null,
      material_composition: textToMaterial(pickStr(r, "혼용율")),
      option1_label: o1.length > 0 ? "색상" : null,
      option2_label: o2.length > 0 ? "사이즈" : null,
      option3_label: null,
      is_active: true,
    }).select("id").single();

    if (pErr || !pData) {
      failed++;
      errors.push(`${productCode} INSERT 실패: ${pErr?.message ?? "unknown"}`);
      continue;
    }

    const combos = cartesian(o1, o2, o3);
    if (combos.length > 0) {
      const { error: vErr } = await supabase.from("product_variants").insert(
        combos.map(c => ({
          product_id: pData.id,
          color: c.o1 || null,
          size: c.o2 || null,
          option3: c.o3 || null,
        }))
      );
      if (vErr) errors.push(`${productCode} variants INSERT 실패: ${vErr.message}`);
    }

    success++;
  }

  return { success, failed, errors };
}

// ────────────────────────────────────────────
// /products 엑셀 다운로드 — 한 row = 한 product 가로 박제 (소비자 + 공급)
// ────────────────────────────────────────────
export interface ExportRow {
  product_code: string;
  progress_memo: string;
  consumer_name: string;
  variants: Variant[];
  regular_sale_price: number | string | null;
  sale_price: number | string | null;
  consumer_price: number | string | null;
  description: string;
  wholesale_name: string;
  wholesale_price: number | null;
  wholesale_discount_price: number | null;
  country_of_origin: string;
  material_composition: string;
  wholesale_supplier: string;
}

const EXPORT_HEADERS = [
  "상품코드", "메모(진행)", "상품명",
  "옵션1", "옵션2(사이즈)", "옵션3",
  "상시판매가", "판매가", "소비자가",
  "메모(샘플)", "공급상품명",
  "공급옵션1(색상)", "공급옵션2(사이즈)", "공급옵션3",
  "공급가", "할인가", "제조국", "혼용율", "공급사",
];

function distinct(arr: (string | null | undefined)[]): string[] {
  const set = new Set<string>();
  for (const v of arr) if (v) set.add(v);
  return Array.from(set);
}

function asNum(v: number | string | null): number | string {
  if (v == null || v === "") return "";
  const n = typeof v === "number" ? v : Number(v);
  return isNaN(n) ? "" : n;
}

export function exportProductsToExcel(rows: ExportRow[]) {
  const data = rows.map(r => {
    const consumerO1 = distinct(r.variants.map(v => v.consumer_label_color || v.color));
    const consumerO2 = distinct(r.variants.map(v => v.consumer_label_size || v.size));
    const consumerO3 = distinct(r.variants.map(v => v.consumer_label_option3 || v.option3));
    const supplyO1   = distinct(r.variants.map(v => v.color));
    const supplyO2   = distinct(r.variants.map(v => v.size));
    const supplyO3   = distinct(r.variants.map(v => v.option3));
    return [
      r.product_code,
      r.progress_memo,
      r.consumer_name,
      consumerO1.join(", "),
      consumerO2.join(", "),
      consumerO3.join(", "),
      asNum(r.regular_sale_price),
      asNum(r.sale_price),
      asNum(r.consumer_price),
      r.description,
      r.wholesale_name,
      supplyO1.join(", "),
      supplyO2.join(", "),
      supplyO3.join(", "),
      asNum(r.wholesale_price),
      asNum(r.wholesale_discount_price),
      r.country_of_origin,
      r.material_composition,
      r.wholesale_supplier,
    ];
  });

  const ws = XLSX.utils.aoa_to_sheet([EXPORT_HEADERS, ...data]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "상품목록");
  const dateStr = new Date().toLocaleDateString("en-CA").replace(/-/g, "");
  XLSX.writeFile(wb, `상품목록_${dateStr}.xlsx`);
}

// ────────────────────────────────────────────
// "60%" 플랫폼 업로드 양식 export (2026-07-20)
// — SKU(variant) 단위 한 줄. 원본 템플릿(public/templates)을 그대로 불러와
//   Template 시트만 교체 → Master 시트(드롭다운 값)는 원본 그대로 보존.
// — 상품명/옵션명 번역 없음. 카테고리/성별/편직/소재/Variant Image URL = 공란,
//   Vendor="un:tyl"/Variant Quantity=9999 고정 (사장 결정 2026-07-20).
// ────────────────────────────────────────────
export interface Platform60ExportInput {
  id: string;
  consumer_name: string;
  consumer_price: string;
  variants: Variant[];
}

// platform=null 이면 원화 그대로(변환 없음). 통화환산 필요한데 환율 미설정이면 에러로 중단
// (호출부가 catch 해서 "환율 설정 필요" 등으로 안내).
export async function exportPlatform60Excel(
  products: Platform60ExportInput[],
  platform: Platform | null,
  fxRates: FxRates,
): Promise<void> {
  const ids = products.map(p => p.id);
  const { data: imgRows } = await supabase
    .from("product_images")
    .select("product_id, url, sort_order")
    .in("product_id", ids)
    .order("sort_order", { ascending: true });

  const imagesByProduct = new Map<string, string[]>();
  for (const r of (imgRows ?? []) as { product_id: string; url: string }[]) {
    const arr = imagesByProduct.get(r.product_id) ?? [];
    arr.push(r.url);
    imagesByProduct.set(r.product_id, arr);
  }

  const sourceProducts: Platform60SourceProduct[] = products.map(p => {
    const baseKrw = p.consumer_price ? Number(p.consumer_price) : 0;
    let price = baseKrw;
    if (platform) {
      const converted = convertToPlatformPrice(baseKrw, platform, fxRates);
      if (converted === null) throw new Error(`환율 설정 필요 (${platform.currency})`);
      price = converted;
    }
    return {
      id: p.id,
      consumer_name: p.consumer_name,
      price,
      variants: p.variants,
      images: imagesByProduct.get(p.id) ?? [],
    };
  });

  const rows = buildPlatform60Rows(sourceProducts);

  const buf = await fetch(TEMPLATE_URL).then(r => r.arrayBuffer());
  const wb = XLSX.read(buf, { type: "array" });

  wb.Sheets[TEMPLATE_SHEET_NAME] = XLSX.utils.aoa_to_sheet([Array.from(TEMPLATE_HEADERS), ...rows]);

  // Prompt 시트 — Template 바로 다음(두 번째) 자리에 삽입, 나머지 Master 시트는 그대로 보존.
  const promptWs = XLSX.utils.aoa_to_sheet(PROMPT_LINES.map(line => [line]));
  promptWs["!cols"] = [{ wch: 120 }];
  wb.Sheets[PROMPT_SHEET_NAME] = promptWs;
  wb.SheetNames = wb.SheetNames.filter(n => n !== PROMPT_SHEET_NAME);
  wb.SheetNames.splice(1, 0, PROMPT_SHEET_NAME);

  const dateStr = new Date().toLocaleDateString("en-CA").replace(/-/g, "");
  XLSX.writeFile(wb, `60업로드_${dateStr}.xlsx`);
}

// ────────────────────────────────────────────
// 사이즈(치수) 일괄 다운로드 / 업로드
// — 카테고리별 measurement_templates.field_keys 가 같은 카테고리끼리 한 시트로 그룹화.
// — row 단위 = (product_id, size). 색상 무관 (product_measurements UNIQUE(product_id, size)).
// — 기존 값 채워서 다운로드 → 사장이 빈칸 채워 / 수정 후 업로드 → UPSERT.
// ────────────────────────────────────────────

// 사장 명시 (2026-05-29): 공급상품명 왼쪽에 상품명(소비자) 추가. consumer_name 빈 경우 "NULL" 표기.
const SIZE_FIXED_HEADERS = ["product_id", "상품코드", "상품명", "공급상품명", "카테고리", "사이즈"] as const;

interface SizeRowOut {
  product_id: string;
  product_code: string;
  consumer_name: string;       // 소비자 상품명 (빈 경우 "NULL" 출력)
  wholesale_name: string;      // 공급상품명
  category: string;
  size: string;
  measurements: Record<string, number | string | null>;
}

export async function downloadSizeMeasurements(tenantId: string) {
  // 1) 활성 products. consumer_name + wholesale_name 둘 다 select (사장 명시 2026-05-29: 둘 다 노출, consumer 빈 경우 NULL 표기)
  const { data: products, error: pErr } = await supabase
    .from("products")
    .select("id, product_code, wholesale_name, consumer_name, category")
    .eq("tenant_id", tenantId)
    .eq("is_active", true);
  if (pErr || !products) throw new Error(`products fetch 실패: ${pErr?.message ?? "unknown"}`);
  if (products.length === 0) { alert("활성 상품이 없습니다."); return; }

  const productIds = products.map(p => p.id);

  // 2) variants distinct size per product. is_active=true 만 (soft delete 옛 variant 제외).
  const { data: variants } = await supabase
    .from("product_variants")
    .select("product_id, size")
    .eq("is_active", true)
    .in("product_id", productIds);
  const sizesByProduct = new Map<string, Set<string>>();
  (variants || []).forEach(v => {
    if (!v.size) return;
    if (!sizesByProduct.has(v.product_id)) sizesByProduct.set(v.product_id, new Set());
    sizesByProduct.get(v.product_id)!.add(v.size);
  });

  // 3) 기존 product_measurements
  const { data: existingMeas } = await supabase
    .from("product_measurements")
    .select("product_id, size, measurements")
    .in("product_id", productIds);
  const measByKey = new Map<string, Record<string, unknown>>();
  (existingMeas || []).forEach(m => {
    measByKey.set(`${m.product_id}::${m.size}`, (m.measurements as Record<string, unknown>) || {});
  });

  // 4) measurement_templates (시스템 공통 + tenant 커스텀)
  const { data: templates } = await supabase
    .from("measurement_templates")
    .select("tenant_id, category, field_keys")
    .or(`tenant_id.is.null,tenant_id.eq.${tenantId}`);
  // 카테고리 매핑: tenant 커스텀 우선, 없으면 시스템 공통
  const tplByCategory = new Map<string, string[]>();
  (templates || []).forEach(t => {
    const fk = (t.field_keys as string[]) || [];
    if (t.tenant_id) tplByCategory.set(t.category, fk);
  });
  (templates || []).forEach(t => {
    if (!t.tenant_id && !tplByCategory.has(t.category)) {
      tplByCategory.set(t.category, (t.field_keys as string[]) || []);
    }
  });

  // 5) (product, size) row 생성 + field_keys 그룹화
  type Group = { fieldKeys: string[]; rows: SizeRowOut[]; categories: Set<string> };
  const groups = new Map<string, Group>(); // key = sorted field_keys JSON
  let totalRows = 0;
  let skippedNoCategory = 0;
  let skippedNoTemplate = 0;

  for (const p of products) {
    const sizes = sizesByProduct.get(p.id);
    if (!sizes || sizes.size === 0) continue;
    const category = p.category || "";
    if (!category) { skippedNoCategory++; continue; }
    const fieldKeys = tplByCategory.get(category);
    if (!fieldKeys || fieldKeys.length === 0) { skippedNoTemplate++; continue; }

    const groupKey = JSON.stringify([...fieldKeys].sort());
    if (!groups.has(groupKey)) {
      groups.set(groupKey, { fieldKeys, rows: [], categories: new Set() });
    }
    const g = groups.get(groupKey)!;
    g.categories.add(category);

    const sortedSizes = Array.from(sizes).sort();
    for (const size of sortedSizes) {
      const existing = measByKey.get(`${p.id}::${size}`) || {};
      g.rows.push({
        product_id: p.id,
        product_code: p.product_code,
        consumer_name: p.consumer_name || "",   // 빈 경우 출력 단계에서 "NULL"
        wholesale_name: p.wholesale_name || "",
        category,
        size,
        measurements: fieldKeys.reduce((acc, key) => {
          const v = existing[key];
          acc[key] = v == null ? "" : (v as number | string);
          return acc;
        }, {} as Record<string, number | string | null>),
      });
      totalRows++;
    }
  }

  if (groups.size === 0) {
    alert("다운로드할 사이즈 row가 없습니다.\n(활성 상품에 카테고리/variants/template 매칭 확인 필요)");
    return;
  }

  // 6) xlsx 생성 — 그룹별 시트
  const wb = XLSX.utils.book_new();
  // Excel 시트명 금지 문자: \ / ? * [ ] : — 모두 "_"로 치환 + 31자 이내 + 중복 방지
  const sanitize = (s: string) => s.replace(/[\\/?*[\]:]/g, "_");
  const usedNames = new Set<string>();
  for (const g of Array.from(groups.values()).sort((a, b) => b.rows.length - a.rows.length)) {
    const cats = Array.from(g.categories).sort();
    let sheetName = sanitize(cats.join("+")).slice(0, 28);
    let suffix = 0;
    while (usedNames.has(sheetName)) {
      suffix++;
      sheetName = (sanitize(cats.join("+")).slice(0, 26) + ` ${suffix}`).slice(0, 28);
    }
    usedNames.add(sheetName);

    const headers = [...SIZE_FIXED_HEADERS, ...g.fieldKeys];
    const data: (string | number | null)[][] = [headers];
    for (const r of g.rows) {
      data.push([
        r.product_id, r.product_code,
        r.consumer_name || "NULL",     // 빈 → "NULL" 시각 표기
        r.wholesale_name || "NULL",
        r.category, r.size,
        ...g.fieldKeys.map(k => {
          const v = r.measurements[k];
          if (v == null || v === "") return "";
          const n = Number(v);
          return isNaN(n) ? String(v) : n;
        }),
      ]);
    }
    const ws = XLSX.utils.aoa_to_sheet(data);
    // 컬럼 폭: product_id 36 / 상품코드 10 / 상품명 24 / 공급상품명 24 / 카테고리 18 / 사이즈 8 / measurements 10
    ws["!cols"] = headers.map((_, i) =>
      i === 0 ? { wch: 36 } : i === 1 ? { wch: 10 } :
      i === 2 ? { wch: 24 } : i === 3 ? { wch: 24 } :
      i === 4 ? { wch: 18 } : i === 5 ? { wch: 8 } : { wch: 10 }
    );
    XLSX.utils.book_append_sheet(wb, ws, sheetName);
  }

  const dateStr = new Date().toLocaleDateString("en-CA").replace(/-/g, "");
  XLSX.writeFile(wb, `사이즈_일괄_${dateStr}.xlsx`);

  const note = [];
  if (skippedNoCategory > 0) note.push(`카테고리 없는 상품 ${skippedNoCategory}개 제외`);
  if (skippedNoTemplate > 0) note.push(`템플릿 매칭 안 되는 카테고리 ${skippedNoTemplate}개 제외`);
  if (note.length) alert(`다운로드 완료: ${totalRows} row / ${groups.size} 시트\n\n${note.join("\n")}`);
}

export interface SizeUploadResult {
  success: number;
  failed: number;
  errors: string[];
}

export async function uploadSizeMeasurements(file: File, tenantId: string): Promise<SizeUploadResult> {
  const buf = await file.arrayBuffer();
  const wb = XLSX.read(buf, { type: "array" });

  // 모든 시트 합쳐서 처리 — 시트마다 헤더 다름 (field_keys)
  type Parsed = { product_id: string; size: string; measurements: Record<string, number> };
  const parsed: Parsed[] = [];
  const errors: string[] = [];

  for (const sheetName of wb.SheetNames) {
    const ws = wb.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(ws, { defval: null });
    if (rows.length === 0) continue;
    const sample = rows[0];
    const fixedSet = new Set<string>(SIZE_FIXED_HEADERS);
    const fieldKeys = Object.keys(sample).filter(k => !fixedSet.has(k));

    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      const pid = String(r["product_id"] || "").trim();
      const size = String(r["사이즈"] || "").trim();
      if (!pid || !size) {
        errors.push(`[${sheetName}] ${i + 2}행: product_id 또는 사이즈 누락 — skip`);
        continue;
      }
      const meas: Record<string, number> = {};
      for (const fk of fieldKeys) {
        const v = r[fk];
        if (v == null || v === "") continue;
        const n = Number(String(v).replace(/[^0-9.-]/g, ""));
        if (!isNaN(n)) meas[fk] = n;
      }
      parsed.push({ product_id: pid, size, measurements: meas });
    }
  }

  if (parsed.length === 0) {
    return { success: 0, failed: 0, errors: ["파일에 유효한 row 없음"] };
  }

  // tenant_id 검증 — 다른 tenant 상품 박제 방지
  const distinctPids = Array.from(new Set(parsed.map(p => p.product_id)));
  const { data: ownProducts } = await supabase
    .from("products")
    .select("id")
    .eq("tenant_id", tenantId)
    .in("id", distinctPids);
  const ownSet = new Set((ownProducts || []).map(p => p.id));

  let success = 0;
  let failed = 0;

  // UPSERT 청크 단위
  const CHUNK = 100;
  const validRows = parsed.filter(p => {
    if (!ownSet.has(p.product_id)) {
      failed++;
      errors.push(`product_id ${p.product_id}: 본 tenant 소유 아님 — skip`);
      return false;
    }
    return true;
  });

  for (let i = 0; i < validRows.length; i += CHUNK) {
    const chunk = validRows.slice(i, i + CHUNK);
    const { error } = await supabase
      .from("product_measurements")
      .upsert(chunk.map(p => ({
        product_id: p.product_id,
        size: p.size,
        measurements: p.measurements,
      })), { onConflict: "product_id,size" });
    if (error) {
      failed += chunk.length;
      errors.push(`UPSERT 청크 실패 (${chunk.length} rows): ${error.message}`);
    } else {
      success += chunk.length;
    }
  }

  return { success, failed, errors };
}
