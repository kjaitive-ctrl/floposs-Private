"use client";

// 지그재그 주문 엑셀(배송준비중 order_item_list) → 주문 탭(사입 주문서) 줄 만들기. 마이그 246.
//
// 상품 찾는 순서 (위에서 찾으면 끝):
//   1. 지그재그 상품번호 — 한 번 연결된 상품에 저장해 둔 번호 (products.zigzag_product_no)
//   2. 상품코드 P0000COA → 카페24 상품번호 (A=0 … Z=25 의 26진수, COA=1716)
//   3. 자체상품코드 = 상품번호 R-xxx
//   4. 상품명 정확히 같음 (소비자 상품명)
//   5. 비슷한 이름 — [ ]·( ) 뺀 이름의 글자쌍 유사도, 1등이 분명할 때만
//   6. 못 찾으면 거래처 "미분류"
// 같은 상품·같은 옵션은 한 줄로 합치고(수량 합), 이미 올린 상품주문번호는 건너뜀.
// 구매자 이름·연락처·주소는 읽지도 저장하지도 않음.
import * as XLSX from "xlsx";
import { supabase } from "@/lib/supabase";
import { variantLabel, type OrderItem, type OrderItemPatch, type OrderProduct, type OrderProductVariant } from "@/lib/purchaseOrder";

export const UNASSIGNED_SUPPLIER = "미분류";

export interface ZigzagRow {
  order_no: string;       // 상품주문번호
  status: string;         // 주문상태
  name: string;           // 상품명
  option: string;         // 옵션정보 "색상: CHARCOAL / 사이즈: FREE"
  qty: number;
  price: number;          // 상품가격 (원)
  code: string;           // 상품코드 P0000COA (없으면 "")
  own_code: string;       // 자체상품코드
  product_no: string;     // 지그재그 상품번호
}

export interface ZigzagVariant extends OrderProductVariant {
  consumer_label_color: string | null;
  consumer_label_size: string | null;
}

export interface ZigzagProduct extends OrderProduct {
  product_code: string | null;
  cafe24_product_no: number | null;
  zigzag_product_no: string | null;
  variants: ZigzagVariant[];
}

export type MatchMethod = "zigzag" | "cafe24" | "code" | "name" | "similar" | "manual" | "none";

export const METHOD_LABEL: Record<MatchMethod, string> = {
  zigzag: "지그재그번호",
  cafe24: "카페24코드",
  code: "상품번호",
  name: "이름 같음",
  similar: "비슷한 이름",
  manual: "직접 고름",
  none: "미분류",
};

// 지그재그 상품 하나(상품번호 기준) — 미리보기 한 줄
export interface ZigzagGroup {
  product_no: string;
  name: string;
  code: string;
  own_code: string;
  rows: ZigzagRow[];
  product: ZigzagProduct | null;
  method: MatchMethod;
  note?: string;  // 비슷한 이름 후보 등
}

// ─────────────────────────── 엑셀 읽기 ───────────────────────────

const REQUIRED = ["상품주문번호", "상품명", "옵션정보", "수량", "상품번호"] as const;

const str = (v: unknown) => (v == null ? "" : String(v)).trim();
const dash = (v: unknown) => { const s = str(v); return s === "-" ? "" : s; };
const num = (v: unknown) => Number(str(v).replace(/[^0-9.-]/g, "")) || 0;

export async function parseZigzagFile(file: File): Promise<ZigzagRow[]> {
  const wb = XLSX.read(await file.arrayBuffer(), { type: "array" });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(ws, { defval: "", raw: false });
  const headers = rows.length ? Object.keys(rows[0]) : [];
  const missing = REQUIRED.filter(h => !headers.includes(h));
  if (missing.length) throw new Error(`지그재그 주문 엑셀이 아닙니다 (없는 칸: ${missing.join(", ")})`);
  return rows
    .map(r => ({
      order_no: str(r["상품주문번호"]),
      status: str(r["주문상태"]),
      name: str(r["상품명"]),
      option: dash(r["옵션정보"]),
      qty: num(r["수량"]),
      price: num(r["상품가격 (원)"]),
      code: dash(r["상품코드"]),
      own_code: dash(r["자체상품코드"]),
      product_no: dash(r["상품번호"]),
    }))
    .filter(r => r.order_no && r.name && r.qty > 0);
}

// 취소·반품된 주문은 사입할 필요 없음
export function isCancelled(r: ZigzagRow) {
  return /취소|반품|환불/.test(r.status);
}

// ─────────────────────────── 상품 불러오기 ───────────────────────────

export async function loadZigzagProducts(tenantId: string): Promise<ZigzagProduct[]> {
  const { data, error } = await supabase
    .from("products")
    .select("id, product_code, cafe24_product_no, zigzag_product_no, consumer_name, wholesale_name, wholesale_supplier, wholesale_price, wholesale_discount_price, wholesale_price_current, sold_out, product_variants(id, color, size, option3, consumer_label_color, consumer_label_size, is_active, sort_order)")
    .eq("tenant_id", tenantId)
    .eq("is_active", true);
  if (error) throw new Error(`상품 불러오기 실패: ${error.message}`);
  return (data ?? []).map(p => {
    const cur = p.wholesale_price_current == null ? null : Number(p.wholesale_price_current);
    const disc = p.wholesale_discount_price == null ? null : Number(p.wholesale_discount_price);
    const price = Number(p.wholesale_price ?? 0);
    return {
      id: p.id,
      product_code: p.product_code,
      cafe24_product_no: p.cafe24_product_no,
      zigzag_product_no: p.zigzag_product_no,
      consumer_name: p.consumer_name,
      wholesale_name: p.wholesale_name,
      wholesale_supplier: p.wholesale_supplier,
      effective_price: cur != null && cur > 0 ? cur : (disc != null && disc > 0 ? disc : price),
      sold_out: p.sold_out ?? false,
      variants: (p.product_variants ?? [])
        .filter(v => v.is_active !== false)
        .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0)),
    };
  });
}

// ─────────────────────────── 상품 찾기 ───────────────────────────

// 카페24 상품코드 P0000COA → 상품번호 1716 (뒤 글자를 A=0…Z=25 의 26진수로)
export function cafe24CodeToNo(code: string): number | null {
  const m = /^P0*([A-Z]+)$/.exec(code.trim().toUpperCase());
  if (!m) return null;
  return [...m[1]].reduce((n, ch) => n * 26 + (ch.charCodeAt(0) - 65), 0);
}

// 이름 비교용 — [기모open]·(핸드워머) 같은 꾸밈말과 띄어쓰기 제거
function coreName(name: string) {
  return name.replace(/\[[^\]]*\]/g, "").replace(/\([^)]*\)/g, "").replace(/\s+/g, "").toLowerCase();
}

function bigrams(s: string) {
  const out: string[] = [];
  for (let i = 0; i < s.length - 1; i++) out.push(s.slice(i, i + 2));
  return out;
}

// 글자쌍 일치도 (0~1)
function similarity(a: string, b: string) {
  const A = bigrams(a), B = bigrams(b);
  if (!A.length || !B.length) return a === b ? 1 : 0;
  const pool = new Map<string, number>();
  B.forEach(x => pool.set(x, (pool.get(x) ?? 0) + 1));
  let hit = 0;
  for (const x of A) { const n = pool.get(x) ?? 0; if (n > 0) { hit++; pool.set(x, n - 1); } }
  return (2 * hit) / (A.length + B.length);
}

const SIMILAR_MIN = 0.6;   // 이보다 낮으면 후보로 안 봄
const SIMILAR_GAP = 0.08;  // 1등과 2등이 이만큼은 차이 나야 1등으로 정함

function findProduct(g: Pick<ZigzagGroup, "product_no" | "code" | "own_code" | "name">, products: ZigzagProduct[]):
  { product: ZigzagProduct | null; method: MatchMethod; note?: string } {
  if (g.product_no) {
    const p = products.find(x => x.zigzag_product_no === g.product_no);
    if (p) return { product: p, method: "zigzag" };
  }
  const no = g.code ? cafe24CodeToNo(g.code) : null;
  if (no != null) {
    const p = products.find(x => x.cafe24_product_no === no);
    if (p) return { product: p, method: "cafe24" };
  }
  if (g.own_code) {
    const hits = products.filter(x => (x.product_code ?? "").trim().toUpperCase() === g.own_code.toUpperCase());
    if (hits.length === 1) return { product: hits[0], method: "code" };
  }
  const exact = products.filter(x => (x.consumer_name ?? "").trim() === g.name.trim());
  if (exact.length === 1) return { product: exact[0], method: "name" };

  const core = coreName(g.name);
  const scored = products
    .filter(x => x.consumer_name)
    .map(x => ({ p: x, s: similarity(core, coreName(x.consumer_name!)) }))
    .filter(x => x.s >= SIMILAR_MIN)
    .sort((a, b) => b.s - a.s);
  if (scored.length && (scored.length === 1 || scored[0].s - scored[1].s >= SIMILAR_GAP)) {
    return { product: scored[0].p, method: "similar" };
  }
  if (scored.length > 1) {
    return { product: null, method: "none", note: `후보 ${scored.length}개: ${scored.slice(0, 3).map(x => x.p.consumer_name).join(" / ")}` };
  }
  return { product: null, method: "none" };
}

// 지그재그 상품번호(없으면 상품명)별로 묶고 상품 찾기
export function groupAndMatch(rows: ZigzagRow[], products: ZigzagProduct[]): ZigzagGroup[] {
  const map = new Map<string, ZigzagGroup>();
  for (const r of rows) {
    const key = r.product_no || `name:${r.name}`;
    let g = map.get(key);
    if (!g) {
      g = { product_no: r.product_no, name: r.name, code: r.code, own_code: r.own_code, rows: [], product: null, method: "none" };
      map.set(key, g);
    }
    g.rows.push(r);
  }
  const groups = Array.from(map.values());
  for (const g of groups) Object.assign(g, findProduct(g, products));
  return groups;
}

// ─────────────────────────── 옵션 찾기 ───────────────────────────

// 같은 색을 가리키는 말 묶음 — 지그재그(영문/한글) ↔ 상품 옵션(한글)
const COLOR_WORDS: string[][] = [
  ["black", "블랙", "검정", "검", "먹"],
  ["white", "화이트", "흰색", "흰", "백색"],
  ["ivory", "아이보리"],
  ["cream", "크림"],
  ["beige", "베이지"],
  ["oatmeal", "오트밀"],
  ["brown", "브라운", "갈색"],
  ["camel", "카멜"],
  ["mocha", "모카"],
  ["khaki", "카키"],
  ["olive", "올리브"],
  ["gray", "grey", "그레이", "회색", "회"],
  ["charcoal", "차콜", "챠콜"],
  ["melange", "멜란지"],
  ["navy", "네이비", "곤색"],
  ["blue", "블루", "파랑", "파란"],
  ["sky", "skyblue", "스카이", "하늘"],
  ["aqua", "아쿠아"],
  ["red", "레드", "빨강"],
  ["wine", "burgundy", "와인", "버건디"],
  ["pink", "핑크"],
  ["purple", "퍼플", "보라"],
  ["lavender", "라벤더"],
  ["yellow", "옐로우", "노랑"],
  ["mustard", "머스타드", "겨자"],
  ["mint", "민트"],
  ["green", "그린", "초록"],
  ["orange", "오렌지", "주황"],
];

const norm = (s: string | null | undefined) => (s ?? "").replace(/\([^)]*\)/g, "").replace(/\s+/g, "").toLowerCase();

function colorWords(value: string): string[] {
  const v = norm(value);
  const group = COLOR_WORDS.find(ws => ws.includes(v));
  return group ?? [v];
}

const FREE = ["free", "f", "프리", "freesize", "프리사이즈", "원사이즈", "onesize"];

// "색상: CHARCOAL / 사이즈: FREE (기모)" → { color, size }
export function parseZigzagOption(option: string): { color: string; size: string } {
  let color = "", size = "";
  for (const part of option.split("/")) {
    const [k, ...rest] = part.split(":");
    const v = rest.join(":").trim();
    if (!v) continue;
    if (/색/.test(k)) color = v;
    else if (/사이즈|size/i.test(k)) size = v;
    else if (!color) color = v;
  }
  return { color, size };
}

// 고객용 옵션명(consumer_label_*)을 먼저 봄 — 도매 색상명과 엇갈리는 상품이 있음
// (예: 한나 워크팬츠 도매 "카키" = 고객 "베이지"). 고객용으로 못 찾을 때만 도매 색상명.
function colorMatches(c: string | null, color: string) {
  if (!color) return true;
  const n = norm(c);
  if (!n) return false;
  return colorWords(color).some(w => n === w || (w.length >= 2 && n.includes(w)) || (n.length >= 2 && w.includes(n)));
}

function sizeMatches(v: ZigzagVariant, size: string, useLabel: boolean) {
  const s = norm(size);
  const x = norm(useLabel ? (v.consumer_label_size ?? v.size) : v.size);
  if (!s || FREE.includes(s)) return !x || FREE.includes(x);
  return x === s;
}

// 옵션 하나로 정해지면 그 옵션 라벨, 아니면 null
export function findVariantLabel(product: ZigzagProduct, option: string): string | null {
  if (product.variants.length === 0) return null;
  const { color, size } = parseZigzagOption(option);
  const hasSize = product.variants.some(v => v.size);
  for (const useLabel of [true, false]) {
    const hits = product.variants.filter(v =>
      colorMatches(useLabel ? (v.consumer_label_color ?? v.color) : v.color, color)
      && (!hasSize || sizeMatches(v, size, useLabel)));
    const labels = Array.from(new Set(hits.map(variantLabel).filter(Boolean)));
    if (labels.length === 1) return labels[0];
    if (labels.length > 1) return null; // 여러 개면 애매 — 비워 둠
  }
  return null;
}

// 옵션정보 → 짧은 글자 "CHARCOAL / FREE (기모)"
export function shortOption(option: string) {
  const { color, size } = parseZigzagOption(option);
  return [color, size].filter(Boolean).join(" / ") || option;
}

// ─────────────────────────── 주문서 줄 만들기 ───────────────────────────

export interface PlannedLine {
  group: ZigzagGroup;
  fields: OrderItemPatch;
  optionMatched: boolean;
}

export function planLines(groups: ZigzagGroup[]): PlannedLine[] {
  const lines: PlannedLine[] = [];
  for (const g of groups) {
    const p = g.product;
    const byOption = new Map<string, { rows: ZigzagRow[]; label: string | null }>();
    for (const r of g.rows) {
      const label = p ? findVariantLabel(p, r.option) : null;
      const key = label ? `v:${label}` : `raw:${shortOption(r.option)}`;
      const cur = byOption.get(key) ?? { rows: [], label };
      cur.rows.push(r);
      byOption.set(key, cur);
    }
    for (const { rows, label } of byOption.values()) {
      const raw = shortOption(rows[0].option);
      const quantity = rows.reduce((a, r) => a + r.qty, 0);
      const source = rows.map(r => ({
        order_no: r.order_no, name: r.name, option: r.option, qty: r.qty, price: r.price, code: r.code, own_code: r.own_code,
      }));
      const fields: OrderItemPatch = p ? {
        product_id: p.id,
        product_name: p.consumer_name || p.wholesale_name || g.name,
        wholesale_name: p.wholesale_name || null,
        supplier_name: (p.wholesale_supplier || "").trim() || null,
        unit_price: p.effective_price || 0,
        // 옵션을 못 찾으면 비워 두고 원래 옵션은 메모에
        variant_label: label,
        memo: label ? null : `지그재그 옵션: ${raw}`,
      } : {
        product_id: null,
        product_name: g.name,
        wholesale_name: null,
        supplier_name: UNASSIGNED_SUPPLIER,
        unit_price: 0,
        variant_label: raw || null,
        memo: null,
      };
      lines.push({
        group: g,
        optionMatched: !p || !!label || p.variants.length === 0,
        fields: {
          ...fields,
          quantity,
          zigzag_order_nos: rows.map(r => r.order_no),
          zigzag_product_no: g.product_no || null,
          zigzag_source: source,
        },
      });
    }
  }
  return lines;
}

// 줄 여러 개를 한 번에 저장 (순서 = 만든 순서)
export async function insertLines(tenantId: string, lines: PlannedLine[]): Promise<{ items: OrderItem[]; error: string | null }> {
  if (lines.length === 0) return { items: [], error: null };
  const { data: maxRow, error: maxErr } = await supabase.from("purchase_order_items").select("sort_order")
    .eq("tenant_id", tenantId).order("sort_order", { ascending: false }).limit(1).maybeSingle();
  if (maxErr) return { items: [], error: maxErr.message };
  const base = maxRow?.sort_order ?? 0;
  const { data, error } = await supabase.from("purchase_order_items")
    .insert(lines.map((l, i) => ({ ...l.fields, tenant_id: tenantId, sort_order: base + i + 1 })))
    .select("*");
  if (error) return { items: [], error: error.message };
  return { items: (data ?? []) as OrderItem[], error: null };
}

// 연결된 상품에 지그재그 상품번호 저장 — 비어 있을 때만 (이미 다른 번호가 있으면 그대로 둠)
export async function rememberZigzagNo(productId: string, zigzagNo: string): Promise<string | null> {
  const { error } = await supabase.from("products")
    .update({ zigzag_product_no: zigzagNo })
    .eq("id", productId).is("zigzag_product_no", null);
  // 같은 번호가 다른 상품에 이미 있으면(유일 제약) 저장하지 않고 넘어감
  if (error && error.code !== "23505") return error.message;
  return null;
}
