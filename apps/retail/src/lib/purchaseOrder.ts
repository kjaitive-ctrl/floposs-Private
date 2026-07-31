// 주문(사입 발주) 시트 — browser-direct. [[feedback_retail_browser_supabase_direct]]
// 마이그 231. 상품명/도매상품명/단가/거래처는 products 에서 골랐을 때 자동
// 채워지는 스냅샷 — 라이브 조인이 아니라서 product 가 나중에 바뀌어도
// 이미 적어둔 행은 그대로 남음.
import { supabase } from "@/lib/supabase";

export interface OrderProductVariant {
  id: string;
  color: string | null;
  size: string | null;
  option3: string | null;
}

export interface OrderProduct {
  id: string;
  consumer_name: string | null;
  wholesale_name: string | null;
  wholesale_supplier: string | null;
  effective_price: number;
  variants: OrderProductVariant[];
}

// 옵션 콤보 표시 라벨 — "블랙 / F" 식으로 색상/사이즈/옵션3 중 값 있는 것만 이어붙임.
export function variantLabel(v: OrderProductVariant): string {
  return [v.color, v.size, v.option3].filter(Boolean).join(" / ");
}

export async function loadOrderProducts(tenantId: string): Promise<OrderProduct[]> {
  const { data, error } = await supabase
    .from("products")
    .select("id, consumer_name, wholesale_name, wholesale_supplier, wholesale_price, wholesale_discount_price, wholesale_price_current, product_variants(id, color, size, option3, is_active)")
    .eq("tenant_id", tenantId)
    .eq("is_active", true);
  if (error) { console.error("loadOrderProducts:", error); return []; }
  return (data ?? []).map(p => {
    const cur = p.wholesale_price_current == null ? null : Number(p.wholesale_price_current);
    const disc = p.wholesale_discount_price == null ? null : Number(p.wholesale_discount_price);
    const price = Number(p.wholesale_price ?? 0);
    const effective_price = cur != null && cur > 0 ? cur : (disc != null && disc > 0 ? disc : price);
    return {
      id: p.id,
      consumer_name: p.consumer_name,
      wholesale_name: p.wholesale_name,
      wholesale_supplier: p.wholesale_supplier,
      effective_price,
      variants: (p.product_variants ?? []).filter((v) => v.is_active !== false),
    };
  });
}

export interface OrderItem {
  id: string;
  product_id: string | null;
  product_name: string | null;
  wholesale_name: string | null;
  variant_label: string | null;
  supplier_name: string | null;
  unit_price: number | null;
  quantity: number;
  sort_order: number;
}

const ORDER_ITEM_COLS = "id, product_id, product_name, wholesale_name, variant_label, supplier_name, unit_price, quantity, sort_order";

export async function loadOrderItems(tenantId: string): Promise<OrderItem[]> {
  const { data, error } = await supabase.from("purchase_order_items")
    .select(ORDER_ITEM_COLS)
    .eq("tenant_id", tenantId)
    .order("sort_order").order("created_at");
  if (error) { console.error("loadOrderItems:", error); return []; }
  return (data ?? []) as OrderItem[];
}

// 빈 행 여러 개를 한 번에 생성 — 회계 매트릭스 "+5줄 추가"와 같은 방식.
export async function addBlankOrderItems(tenantId: string, count: number): Promise<{ items: OrderItem[]; error: string | null }> {
  const { data: maxRow, error: maxErr } = await supabase.from("purchase_order_items").select("sort_order")
    .eq("tenant_id", tenantId).order("sort_order", { ascending: false }).limit(1).maybeSingle();
  if (maxErr) { console.error("addBlankOrderItems (sort_order lookup):", maxErr); return { items: [], error: maxErr.message }; }
  let sort_order = maxRow?.sort_order ?? 0;
  const rows = Array.from({ length: count }, () => ({ tenant_id: tenantId, quantity: 0, sort_order: ++sort_order }));
  const { data, error } = await supabase.from("purchase_order_items").insert(rows).select(ORDER_ITEM_COLS);
  if (error) { console.error("addBlankOrderItems:", error); return { items: [], error: error.message }; }
  return { items: (data ?? []) as OrderItem[], error: null };
}

export type OrderItemPatch = Partial<Omit<OrderItem, "id" | "sort_order">>;

export async function updateOrderItem(id: string, patch: OrderItemPatch): Promise<void> {
  await supabase.from("purchase_order_items").update({ ...patch, updated_at: new Date().toISOString() }).eq("id", id);
}

// 자식 레코드가 이 테이블을 참조하는 곳이 없어서 완전삭제로 충분.
export async function deleteOrderItem(id: string): Promise<void> {
  await supabase.from("purchase_order_items").delete().eq("id", id);
}
