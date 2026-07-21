// retail 거래처(retail_suppliers) + slot 매장 조회/생성 공용 헬퍼.
// 안건1(샘플 공급사 picker) / 안건3(주문포털 거래처 선택) / 미래 C 단계 공용.
// [[project_retail_slot_order_portal_v2]] [[feedback_retail_browser_supabase_direct]]
import { supabase } from "@/lib/supabase";
import type { PortalProduct, ProductOption } from "@/lib/orderPortal";

export interface SlotBrief {
  id: string;
  building: string;
  floor: number;          // B는 음수 (B2=-2)
  wing: string | null;
  section: string | null;
  unit: string;
}

export interface SlotStoreHit {
  id: string;             // slot_stores.id
  store_name: string;
  phone: string | null;       // 02/031/070
  smartphone: string | null;  // 010
  slot: SlotBrief;
}

// 층 표기 — admin StoresView.floorLabel 과 동일 (단일 소스)
export function floorLabel(f: number): string {
  return f < 0 ? `B${-f}층` : `${f}층`;
}

// 슬롯 위치 한 줄 표기: "디오트 1층 J 124호"
export function slotLabel(s: SlotBrief): string {
  const parts: string[] = [s.building, floorLabel(s.floor)];
  if (s.wing) parts.push(s.wing);
  if (s.section) parts.push(s.section);
  parts.push(`${s.unit}호`);
  return parts.join(" ");
}

// 축약 위치 (표 셀 옆 회색): "디오트 1층 C 124호"
export function shortSlotLabel(s: { building: string; floor: number; section: string | null; unit?: string | null }): string {
  const f = s.floor < 0 ? `B${-s.floor}` : `${s.floor}`;
  return [s.building, `${f}층`, s.section, s.unit ? `${s.unit}호` : null].filter(Boolean).join(" ");
}

// products fetch 의 nested retail_suppliers(slots(...)) → 축약 위치 추출.
interface SlotLocLite { building: string; floor: number; section: string | null; unit?: string | null; public_code?: string | null }
export interface NestedSupplier { slots: SlotLocLite | SlotLocLite[] | null }
export function shortLocFromNested(rs: NestedSupplier | NestedSupplier[] | null | undefined): string {
  const s = Array.isArray(rs) ? rs[0] : rs;
  if (!s) return "";
  const slot = Array.isArray(s.slots) ? s.slots[0] : s.slots;
  if (!slot) return "";
  return shortSlotLabel(slot);
}

type RawHit = {
  id: string;
  store_name: string;
  phone: string | null;
  smartphone: string | null;
  slots: SlotBrief | SlotBrief[] | null;
};

type RpcRow = {
  id: string; store_name: string; phone: string | null; smartphone: string | null;
  slot_id: string; building: string; floor: number; wing: string | null; section: string | null; unit: string;
};

// 매장명 자동완성 — 트라이그램 유사검색 (오타 허용, 마이그 037 RPC). 브라우저 직통 (속도가 생명).
// 037 미적용 환경에선 substring(ilike) fallback.
export async function searchSlotStores(q: string, limit = 12): Promise<SlotStoreHit[]> {
  const term = q.trim();
  if (!term) return [];

  const { data, error } = await supabase.rpc("search_slot_stores", { q: term, lim: limit });
  if (!error && data) {
    return (data as RpcRow[]).map(r => ({
      id: r.id, store_name: r.store_name, phone: r.phone, smartphone: r.smartphone,
      slot: { id: r.slot_id, building: r.building, floor: r.floor, wing: r.wing, section: r.section, unit: r.unit },
    }));
  }

  // fallback — RPC(037) 미적용. substring only.
  const { data: d2 } = await supabase
    .from("slot_stores")
    .select("id, store_name, phone, smartphone, slots!inner(id, building, floor, wing, section, unit)")
    .eq("is_hidden", false)
    .ilike("store_name", `%${term}%`)
    .limit(limit);
  return ((d2 ?? []) as RawHit[]).map(r => ({
    id: r.id,
    store_name: r.store_name,
    phone: r.phone,
    smartphone: r.smartphone,
    slot: (Array.isArray(r.slots) ? r.slots[0] : r.slots) as SlotBrief,
  }));
}

// ── 내 거래처 목록 (안건3 C2 — 주문포털 거래처 선택) ──────────
export interface MySupplier {
  id: string;                 // retail_suppliers.id
  slot_id: string;            // 수신 slot (전자노트 recipient_slot_id)
  public_code?: string | null; // slot 공유 URL 코드 (loadSupplierBrief 에서만 채움)
  store_name: string;         // selected_store_id → slot_stores.store_name
  loc: string;                // 축약 위치 "디오트1J"
  phone: string | null;
  smartphone: string | null;
}

type MySupplierRow = {
  id: string;
  slot_id: string;
  slots: SlotLocLite | SlotLocLite[] | null;
  store: { store_name: string; phone: string | null; smartphone: string | null }
       | { store_name: string; phone: string | null; smartphone: string | null }[]
       | null;
};

// 내 거래처(retail_suppliers) 전체 — 주문포털에서 검색/선택. 브라우저 직통(내 데이터, cross-tenant X).
// 건수가 tenant 단위로 bounded → 전체 load 후 클라이언트 필터.
export async function loadMySuppliers(tenantId: string): Promise<MySupplier[]> {
  const { data, error } = await supabase
    .from("retail_suppliers")
    .select("id, slot_id, slots(building, floor, section, unit), store:slot_stores!selected_store_id(store_name, phone, smartphone)")
    .eq("retail_tenant_id", tenantId);
  if (error || !data) { console.error("loadMySuppliers:", error); return []; }
  return (data as MySupplierRow[])
    .map(r => {
      const store = Array.isArray(r.store) ? r.store[0] : r.store;
      return {
        id: r.id,
        slot_id: r.slot_id,
        store_name: store?.store_name ?? "(이름 없음)",
        loc: shortLocFromNested({ slots: r.slots }),
        phone: store?.phone ?? null,
        smartphone: store?.smartphone ?? null,
      };
    })
    .sort((a, b) => a.store_name.localeCompare(b.store_name, "ko"));
}

// 단일 거래처 brief — 주문 페이지(C3) 헤더용.
export async function loadSupplierBrief(tenantId: string, supplierId: string): Promise<MySupplier | null> {
  const { data, error } = await supabase
    .from("retail_suppliers")
    .select("id, slot_id, slots(building, floor, section, public_code), store:slot_stores!selected_store_id(store_name, phone, smartphone)")
    .eq("retail_tenant_id", tenantId)
    .eq("id", supplierId)
    .maybeSingle();
  if (error || !data) { if (error) console.error("loadSupplierBrief:", error); return null; }
  const r = data as MySupplierRow;
  const store = Array.isArray(r.store) ? r.store[0] : r.store;
  const slotObj = Array.isArray(r.slots) ? r.slots[0] : r.slots;
  return {
    id: r.id,
    slot_id: r.slot_id,
    public_code: slotObj?.public_code ?? null,
    store_name: store?.store_name ?? "(이름 없음)",
    loc: shortLocFromNested({ slots: r.slots }),
    phone: store?.phone ?? null,
    smartphone: store?.smartphone ?? null,
  };
}

// 이 거래처(retail_supplier_id 태깅)로 등록된 "내 상품" + variants → ProductGrid 용 PortalProduct.
// 내 데이터(cross-tenant X) 브라우저 직통. 단가는 hidden 이지만 staging 박제용으로 계산해 흐름.
// 단가 규칙 = API(SaleForm 패턴): variant.is_sale 이면 sale_price 우선, 없으면 base_price. (안건3 C3)
export async function loadSupplierProducts(tenantId: string, supplierId: string): Promise<PortalProduct[]> {
  const { data: products, error: pErr } = await supabase
    .from("products")
    .select("id, name, product_code, consumer_name, wholesale_price, wholesale_discount_price, wholesale_price_current")
    .eq("tenant_id", tenantId)
    .eq("retail_supplier_id", supplierId)
    .eq("is_active", true)
    .order("name", { ascending: true });
  if (pErr || !products || products.length === 0) {
    if (pErr) console.error("loadSupplierProducts:", pErr);
    return [];
  }

  const ids = products.map(p => p.id);
  const { data: variants } = await supabase
    .from("product_variants")
    .select("id, product_id, color, size, option3, barcode, consumer_label_color, consumer_label_size, consumer_label_option3")
    .in("product_id", ids)
    .eq("is_active", true)
    .order("color", { ascending: true })
    .order("size", { ascending: true });

  // 단가 = 도매가 (할인가 있으면 우선). 전송 시점에 노트로 박제됨 [결정2/A].
  const priceMap = new Map(
    products.map(p => {
      const cur = p.wholesale_price_current == null ? null : Number(p.wholesale_price_current);
      const price = Number(p.wholesale_price ?? 0);
      const disc = p.wholesale_discount_price == null ? null : Number(p.wholesale_discount_price);
      // 우선순위: 현재가 → 할인가 → 원본
      const effective = cur != null && cur > 0 ? cur : (disc != null && disc > 0 ? disc : price);
      return [p.id, effective];
    })
  );

  const byProduct = new Map<string, ProductOption[]>();
  for (const v of variants ?? []) {
    const list = byProduct.get(v.product_id) ?? [];
    list.push({
      variant_id: v.id, color: v.color, size: v.size, option3: v.option3,
      barcode: v.barcode ?? null, unit_price: priceMap.get(v.product_id) ?? 0,
      consumer_color: v.consumer_label_color, consumer_size: v.consumer_label_size, consumer_option3: v.consumer_label_option3,
    });
    byProduct.set(v.product_id, list);
  }

  return products.map(p => ({
    product_id: p.id,
    product_name: p.name,
    product_code: p.product_code,
    consumer_name: p.consumer_name,
    variants: byProduct.get(p.id) ?? [],
  }));
}

// (tenant, slot) 거래처 매핑 find-or-create → retail_supplier_id 반환.
// 선택한 매장(slotStoreId) 을 selected_store_id 로 반영. 실패 시 null (호출부 텍스트 fallback).
export async function ensureRetailSupplier(
  tenantId: string,
  slotId: string,
  slotStoreId: string | null,
): Promise<string | null> {
  const { data: existing } = await supabase
    .from("retail_suppliers")
    .select("id, selected_store_id")
    .eq("retail_tenant_id", tenantId)
    .eq("slot_id", slotId)
    .maybeSingle();

  if (existing) {
    if (slotStoreId && existing.selected_store_id !== slotStoreId) {
      await supabase
        .from("retail_suppliers")
        .update({ selected_store_id: slotStoreId, updated_at: new Date().toISOString() })
        .eq("id", existing.id);
    }
    return existing.id;
  }

  const { data, error } = await supabase
    .from("retail_suppliers")
    .insert({ retail_tenant_id: tenantId, slot_id: slotId, selected_store_id: slotStoreId })
    .select("id")
    .single();
  if (error || !data) {
    console.error("ensureRetailSupplier:", error);
    return null;
  }
  return data.id;
}

// ── 빠른등록 (B2) ──────────────────────────────────────────
// slot 정의 = admin StoresView 와 동일 단일 소스 (slot_buildings / slot_field_options).
export interface BuildingDef { name: string; category: string; }
export interface FieldOpt { value: string; label: string | null; }

export async function loadSlotBuildings(): Promise<BuildingDef[]> {
  const { data } = await supabase.from("slot_buildings").select("name, category").order("sort");
  return (data ?? []) as BuildingDef[];
}

export async function loadFloorOptions(): Promise<FieldOpt[]> {
  return loadFieldOptions("floor");
}

// slot_field_options 의 임의 필드(floor/section/wing) 옵션 로드 — 주소검색 캐스케이드용.
export async function loadFieldOptions(field: string): Promise<FieldOpt[]> {
  const { data } = await supabase
    .from("slot_field_options").select("value, label").eq("field", field).order("sort");
  return (data ?? []) as FieldOpt[];
}

// 주소(건물→층→구분→열→호)로 slot 검색 → 그 자리 매장 목록. 채운 만큼 좁힘.
// 이름 대신 주소(normalized 자리)로 찾아 중복등록 최소화 (안건3 C2). 브라우저 직통.
export interface AddressQuery {
  building: string;             // 필수
  floor?: number | null;
  section?: string | null;
  wing?: string | null;
  unit?: string;                // 부분일치(ilike)
}
export async function searchSlotsByAddress(p: AddressQuery, limit = 50): Promise<SlotStoreHit[]> {
  let q = supabase
    .from("slot_stores")
    .select("id, store_name, phone, smartphone, is_current, store_order, slots!inner(id, building, floor, wing, section, unit)")
    .eq("is_hidden", false)
    .eq("slots.building", p.building);
  if (p.floor != null) q = q.eq("slots.floor", p.floor);
  if (p.section) q = q.eq("slots.section", p.section);
  if (p.wing) q = q.eq("slots.wing", p.wing);
  if (p.unit && p.unit.trim()) q = q.ilike("slots.unit", `%${p.unit.trim()}%`);
  // 현재 매장 우선, 그다음 최신 등록순 (is_current 플래그 누락 seed 대비 — eq 필터 대신 정렬)
  const { data, error } = await q
    .order("is_current", { ascending: false, nullsFirst: false })
    .order("store_order", { ascending: false })
    .limit(limit);
  if (error || !data) { console.error("searchSlotsByAddress:", error); return []; }
  return (data as RawHit[]).map(r => ({
    id: r.id,
    store_name: r.store_name,
    phone: r.phone,
    smartphone: r.smartphone,
    slot: (Array.isArray(r.slots) ? r.slots[0] : r.slots) as SlotBrief,
  }));
}

export interface QuickRegisterInput {
  building: string;
  category: string | null;
  isCustomBuilding?: boolean;   // 직접입력 건물 → slot_buildings 등록
  floor: number;                // 숫자 (B2=-2). normalized_key 정합 (admin과 동일)
  unit: string;
  storeName: string;
  phone?: string;               // 02/031/070
  smartphone?: string;          // 010
}

// 빠른등록: slot find-or-create(normalized_key) + slot_store 추가 + retail_supplier 박제.
// 빠른등록은 wing/section 없음 → normalized_key 의 해당 자리 "-".
// admin SlotAddModal / StoreAddRow 의 박제 규칙과 동일 ([[feedback_central_source_of_truth]]).
export async function createSlotStoreSupplier(
  tenantId: string,
  inp: QuickRegisterInput,
): Promise<{ supplierId: string | null; storeName: string; loc: string } | null> {
  const building = inp.building.trim();
  const unit = inp.unit.trim();
  const storeName = inp.storeName.trim();
  if (!building || !unit || !storeName) return null;

  const nk = `${building}:${inp.floor}:-:-:${unit}`;

  // 직접입력 건물 → slot_buildings 선등록 (다음 dropdown 노출)
  if (inp.isCustomBuilding && inp.category) {
    await supabase.from("slot_buildings")
      .upsert({ name: building, category: inp.category, user_addable: true }, { onConflict: "name", ignoreDuplicates: true });
  }

  // 1) slot find-or-create — 같은 자리면 재사용 (중복 slot 방지)
  let slotId: string;
  const { data: existingSlot } = await supabase
    .from("slots").select("id").eq("normalized_key", nk).maybeSingle();
  if (existingSlot) {
    slotId = existingSlot.id;
  } else {
    const { data: newSlot, error: slotErr } = await supabase.from("slots").insert({
      building, category: inp.category, floor: inp.floor, wing: null, section: null,
      unit, normalized_key: nk, is_physical: true,
    }).select("id").single();
    if (slotErr || !newSlot) { console.error("createSlot:", slotErr); return null; }
    slotId = newSlot.id;
  }

  // 2) slot_store 추가 — store_order = max+1, 새 매장을 current 로 (기존 current off)
  const { data: maxRow } = await supabase
    .from("slot_stores").select("store_order")
    .eq("slot_id", slotId).order("store_order", { ascending: false }).limit(1).maybeSingle();
  const nextOrder = (maxRow?.store_order ?? 0) + 1;
  await supabase.from("slot_stores").update({ is_current: false }).eq("slot_id", slotId);
  const { data: store, error: storeErr } = await supabase.from("slot_stores").insert({
    slot_id: slotId, store_name: storeName,
    phone: inp.phone?.trim() || null, smartphone: inp.smartphone?.trim() || null,
    store_order: nextOrder, is_current: true,
  }).select("id").single();
  if (storeErr || !store) { console.error("createSlotStore:", storeErr); return null; }

  // 3) retail_supplier 박제
  const supplierId = await ensureRetailSupplier(tenantId, slotId, store.id);
  const loc = shortSlotLabel({ building, floor: inp.floor, section: null });
  return { supplierId, storeName, loc };
}
