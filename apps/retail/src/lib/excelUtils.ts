"use client";

// 엑셀 양식 다운로드 / 일괄 업로드 / 상품목록 export — 모두 클라이언트 측 SheetJS 처리.
// 양식 수정 시 UPLOAD_COLUMNS / EXPORT_HEADERS / 매핑 로직 만 손보면 됨.

import * as XLSX from "xlsx";
import { supabase } from "@/lib/supabase";
import { cartesian, split, textToMaterial } from "@/lib/samplesUtils";
import type { Variant } from "@/lib/samplesUtils";

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
