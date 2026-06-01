// retail 거래처(retail_suppliers) + slot 매장 조회/생성 공용 헬퍼.
// 안건1(샘플 공급사 picker) / 안건3(주문포털 거래처 선택) / 미래 C 단계 공용.
// [[project_retail_slot_order_portal_v2]] [[feedback_retail_browser_supabase_direct]]
import { supabase } from "@/lib/supabase";

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

type RawHit = {
  id: string;
  store_name: string;
  phone: string | null;
  smartphone: string | null;
  slots: SlotBrief | SlotBrief[] | null;
};

// 매장명 자동완성 — slot_stores 를 store_name ilike 로 검색 (숨김 제외).
// 브라우저 직통 (속도가 생명).
export async function searchSlotStores(q: string, limit = 12): Promise<SlotStoreHit[]> {
  const term = q.trim();
  if (!term) return [];
  const { data, error } = await supabase
    .from("slot_stores")
    .select("id, store_name, phone, smartphone, slots!inner(id, building, floor, wing, section, unit)")
    .eq("is_hidden", false)
    .ilike("store_name", `%${term}%`)
    .limit(limit);
  if (error) {
    console.error("searchSlotStores:", error);
    return [];
  }
  return ((data ?? []) as RawHit[]).map(r => ({
    id: r.id,
    store_name: r.store_name,
    phone: r.phone,
    smartphone: r.smartphone,
    slot: (Array.isArray(r.slots) ? r.slots[0] : r.slots) as SlotBrief,
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
  const { data } = await supabase
    .from("slot_field_options").select("value, label").eq("field", "floor").order("sort");
  return (data ?? []) as FieldOpt[];
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
): Promise<{ supplierId: string | null; storeName: string } | null> {
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
  return { supplierId, storeName };
}
