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
