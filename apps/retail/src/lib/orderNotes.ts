// 전자노트(발신) 조회 — retail 본인이 보낸 주문내역 (안건3 C4 Phase C).
// retail 은 자기 발신만 봄 (수신/처리는 wholesale 측). browser-direct.
// [[project_retail_slot_order_portal_v2]] [[feedback_retail_browser_supabase_direct]]
import { supabase } from "@/lib/supabase";
import { shortLocFromNested } from "@/lib/retailSuppliers";

export interface OrderNoteItem {
  quantity: number;
  unit_price: number;
  supplier_product_name: string | null;
  consumer_product_name: string | null;
  supplier_option_label: string | null;
  consumer_option_label: string | null;
  variant_barcode: string | null;
}

export interface OrderNote {
  id: string;
  sent_at: string;
  is_test: boolean;
  status: string;
  pickup_status: "pending" | "picked" | "failed";   // 물류(삼촌) 픽업 상태 [[project_logi_axis]]
  store_name: string;   // 수신 거래처(도매) 매장명
  loc: string;          // 축약 위치
  items: OrderNoteItem[];
  total_qty: number;
  total_amount: number;
}

type SlotLoc = { building: string; floor: number; section: string | null };
type NoteSupplier = {
  slots: SlotLoc | SlotLoc[] | null;
  store: { store_name: string } | { store_name: string }[] | null;
};
type NoteRow = {
  id: string;
  sent_at: string;
  is_test: boolean;
  status: string;
  pickup_status: "pending" | "picked" | "failed";
  supplier: NoteSupplier | NoteSupplier[] | null;
  items: OrderNoteItem[] | null;
};

// 내가 보낸 주문내역 — 최신순. sender_hidden 제외.
export async function loadMyOrderNotes(tenantId: string): Promise<OrderNote[]> {
  const { data, error } = await supabase
    .from("order_notes")
    .select(`
      id, sent_at, is_test, status, pickup_status,
      supplier:retail_suppliers!sender_retail_supplier_id (
        slots ( building, floor, section ),
        store:slot_stores!selected_store_id ( store_name )
      ),
      items:order_note_items (
        quantity, unit_price, supplier_product_name, consumer_product_name,
        supplier_option_label, consumer_option_label, variant_barcode
      )
    `)
    .eq("sender_retail_tenant_id", tenantId)
    .eq("sender_hidden", false)
    .order("sent_at", { ascending: false });

  if (error || !data) { console.error("loadMyOrderNotes:", error); return []; }

  return (data as NoteRow[]).map(r => {
    const sup = Array.isArray(r.supplier) ? r.supplier[0] : r.supplier;
    const storeRaw = sup ? (Array.isArray(sup.store) ? sup.store[0] : sup.store) : null;
    const items = (r.items ?? []) as OrderNoteItem[];
    return {
      id: r.id,
      sent_at: r.sent_at,
      is_test: r.is_test,
      status: r.status,
      pickup_status: r.pickup_status ?? "pending",
      store_name: storeRaw?.store_name ?? "(거래처)",
      loc: shortLocFromNested(sup ? { slots: sup.slots } : null),
      items,
      total_qty: items.reduce((a, i) => a + i.quantity, 0),
      total_amount: items.reduce((a, i) => a + i.quantity * Number(i.unit_price ?? 0), 0),
    };
  });
}
