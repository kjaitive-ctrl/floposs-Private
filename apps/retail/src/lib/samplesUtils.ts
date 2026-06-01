// /samples 인라인 표 — 유틸 + 타입.
// page.tsx 와 미래 다른 인라인 표(/products 등) 에서 재사용.

// ─── 타입 ───────────────────────────────────────────
export type Variant = {
  id?: string;
  color: string | null;
  size: string | null;
  option3: string | null;
  // 마이그 188 — variant 단위 정공법 박제
  consumer_label_color?: string | null;
  consumer_label_size?: string | null;
  consumer_label_option3?: string | null;
  is_for_sale?: boolean;
  sold_out?: boolean;
  variant_code?: string | null;
  sort_order?: number;  // 마이그 033 — 클라이언트 INSERT 순 보존 박제
};

export type DbVariant = Variant & { is_active?: boolean; created_at?: string };

export type DbProduct = {
  id: string;
  product_code: string | null;
  barcode: string | null;            // 마이그 198 — 진행 시 자동 발급(18자리). 샘플 회귀 시 NULL.
  wholesale_name: string | null;
  wholesale_supplier: string | null;
  retail_supplier_id: string | null;  // 마이그 036 — slot 기반 거래처 링크 (안건1)
  // nested fetch — 축약 위치 표시용 (retail_suppliers → slots)
  retail_suppliers?: import("@/lib/retailSuppliers").NestedSupplier | import("@/lib/retailSuppliers").NestedSupplier[] | null;
  category: string | null;
  wholesale_price: number | null;
  wholesale_discount_price: number | null;
  status: string | null;
  launch_date: string | null;
  return_deadline: string | null;
  return_shipped_date: string | null;
  description: string | null;
  country_of_origin: string | null;
  material_composition: Record<string, unknown> | null;
  product_variants: DbVariant[] | null;
  // 소비자(retail) 박제 — /products 에서 사장이 입력. 공급(wholesale_*) 과 별개. 마이그 186.
  consumer_name: string | null;
  consumer_option1?: string | null;
  consumer_option2?: string | null;
  consumer_option3?: string | null;
  // 진행 단계 메모 (products 측 박제) — samples 단계 description 과 별도. 마이그 187.
  progress_memo: string | null;
  // 가격 — sale_price 기존 컬럼 재사용 + consumer_price/regular_sale_price 마이그 182
  sale_price?: number | null;
  consumer_price?: number | null;
  regular_sale_price?: number | null;
  // 마이그 201 — 상품 전체 품절 토글 (variant.sold_out 와 OR 관계)
  sold_out?: boolean | null;
  // count 형태로 fetch — supabase nested aggregate. [{ count: N }]
  product_images?: { count: number }[] | null;
  product_measurements?: { count: number }[] | null;
  product_shoots?: { count: number }[] | null;
  // MD기능 멘트 박제 (products.comment_data) — 버튼 초록 판정용
  comment_data?: string | null;
};

export interface EditableRow {
  _key: string;          // client-side stable key (id 박제 전/후 모두 일관)
  id?: string;           // DB row id (없으면 draft)
  product_code: string;  // read-only 표시
  wholesale_name: string;
  wholesale_supplier: string;
  retail_supplier_id: string | null;  // 마이그 036 — slot 기반 거래처 링크 (안건1)
  supplier_loc: string;                // 축약 위치 표시용 "디오트1J" (DB 박제 X)
  category: string;
  wholesale_price: string;
  wholesale_discount_price: string;
  status: string;
  launch_date: string;
  return_deadline: string;
  return_shipped_date: string;
  option1: string;
  option2: string;
  option3: string;
  description: string;
  country_of_origin: string;
  material_composition: string;  // UI 표시용 텍스트 "면 70, 폴리 30". DB 박제 시 JSONB 변환.
  // 소비자(retail) 박제 — /products 에서 사장이 입력. 마이그 186.
  consumer_name: string;
  consumer_option1: string;
  consumer_option2: string;
  consumer_option3: string;
  // 진행 단계 메모 (products 측 박제) — 마이그 187.
  progress_memo: string;
}

export type SaveStatus = "saving" | "saved" | "error";


// ─── row 생성 ─────────────────────────────────────────
export const newKey = () => `r-${Math.random().toString(36).slice(2, 10)}`;

export const emptyRow = (): EditableRow => ({
  _key: newKey(),
  product_code: "",
  wholesale_name: "",
  wholesale_supplier: "",
  retail_supplier_id: null,
  supplier_loc: "",
  category: "",
  wholesale_price: "",
  wholesale_discount_price: "",
  status: "sample_received",
  launch_date: "",
  return_deadline: "",
  return_shipped_date: "",
  option1: "",
  option2: "",
  option3: "",
  description: "",
  country_of_origin: "",
  material_composition: "",
  consumer_name: "",
  consumer_option1: "",
  consumer_option2: "",
  consumer_option3: "",
  progress_memo: "",
});


// ─── material_composition JSONB ↔ 텍스트 ─────────────
// 텍스트 "면 70, 폴리 30" → JSONB {"면": 70, "폴리": 30}
export function textToMaterial(s: string): Record<string, number> | null {
  if (!s.trim()) return null;
  const out: Record<string, number> = {};
  // 다양한 형식 지원:
  //   "면 70, 폴리 30"           (콤마+공백)
  //   "면65%폴리에스테르35%"     (% 포함, 공백 없음 — raw 입력)
  //   "코튼60% 폴리에스테르40%"  (% + 공백 혼용)
  // 정규식: 한글/영문 이름 + 숫자(소수 가능) + 옵션 %
  const regex = /([가-힣A-Za-z·]+)\s*(\d+(?:\.\d+)?)\s*%?/g;
  let m;
  while ((m = regex.exec(s)) !== null) {
    const k = m[1].trim();
    const n = parseFloat(m[2]);
    if (k && !isNaN(n)) out[k] = n;
  }
  return Object.keys(out).length ? out : null;
}

// JSONB {"면": 70, "폴리": 30} → 텍스트 "면 70, 폴리 30"
export function materialToText(m: Record<string, unknown> | null | undefined): string {
  if (!m || typeof m !== "object") return "";
  return Object.entries(m)
    .map(([k, v]) => `${k} ${v}`)
    .join(", ");
}


// ─── 옵션 (콤마 텍스트 ↔ 카르테시안 곱) ──────────────────
// "BLACK, WHITE" → ["BLACK", "WHITE"]
export const split = (s: string) => s.split(",").map(x => x.trim()).filter(Boolean);

// 3축 옵션 카르테시안 곱 — 빈 축은 [""] 로 대체. 빈 콤보 (전부 빈값) 는 제외.
export function cartesian(a: string[], b: string[], c: string[]) {
  const A = a.length ? a : [""];
  const B = b.length ? b : [""];
  const C = c.length ? c : [""];
  const out: { o1: string; o2: string; o3: string }[] = [];
  for (const x of A) for (const y of B) for (const z of C) {
    if (x || y || z) out.push({ o1: x, o2: y, o3: z });
  }
  return out;
}

// variant 비교용 key — DB row 와 카르테시안 콤보 양쪽 같은 포맷.
export const vKeyVar = (v: Variant) =>
  `${v.color || ""}|${v.size || ""}|${v.option3 || ""}`;

export const vKeyCombo = (c: { o1: string; o2: string; o3: string }) =>
  `${c.o1 || ""}|${c.o2 || ""}|${c.o3 || ""}`;

// variants 배열에서 한 axis 의 distinct 값을 콤마로 join (UI 표시용)
export const joinUniq = (vs: Variant[] | undefined, key: keyof Variant) => {
  if (!vs?.length) return "";
  const set = new Set<string>();
  for (const v of vs) {
    const val = v[key];
    if (typeof val === "string" && val) set.add(val);
  }
  return Array.from(set).join(", ");
};
