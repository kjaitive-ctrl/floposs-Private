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
  sold_out: boolean;
  variants: OrderProductVariant[];
}

// 옵션 콤보 표시 라벨 — "블랙 / F" 식으로 색상/사이즈/옵션3 중 값 있는 것만 이어붙임.
export function variantLabel(v: OrderProductVariant): string {
  return [v.color, v.size, v.option3].filter(Boolean).join(" / ");
}

export async function loadOrderProducts(tenantId: string): Promise<OrderProduct[]> {
  const { data, error } = await supabase
    .from("products")
    .select("id, consumer_name, wholesale_name, wholesale_supplier, wholesale_price, wholesale_discount_price, wholesale_price_current, sold_out, product_variants(id, color, size, option3, is_active)")
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
      sold_out: p.sold_out ?? false,
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
  created_at: string;
  // 마이그 237 — 반품·교환·수거완료·메모·보류. 주문 이미지에는 나가지 않음.
  claim_type?: OrderClaimType | null;
  claim_quantity?: number | null;
  claim_collected_at?: string | null;
  memo?: string | null;
  held_at?: string | null;
}

export type OrderClaimType = "return" | "exchange";

export async function loadOrderItems(tenantId: string): Promise<OrderItem[]> {
  const { data, error } = await supabase.from("purchase_order_items")
    .select("*")
    .eq("tenant_id", tenantId)
    .order("sort_order").order("created_at");
  if (error) { console.error("loadOrderItems:", error); return []; }
  return (data ?? []) as OrderItem[];
}

export type OrderItemPatch = Partial<Omit<OrderItem, "id" | "sort_order" | "created_at">>;

// 맨 위 입력 줄에서 Enter 로 등록할 때 한 행 생성 — 샘플 등록과 같은 방식.
export async function addOrderItem(tenantId: string, fields: OrderItemPatch): Promise<{ item: OrderItem | null; error: string | null }> {
  const { data: maxRow, error: maxErr } = await supabase.from("purchase_order_items").select("sort_order")
    .eq("tenant_id", tenantId).order("sort_order", { ascending: false }).limit(1).maybeSingle();
  if (maxErr) { console.error("addOrderItem (sort_order lookup):", maxErr); return { item: null, error: maxErr.message }; }
  const { data, error } = await supabase.from("purchase_order_items")
    .insert({ ...fields, tenant_id: tenantId, sort_order: (maxRow?.sort_order ?? 0) + 1 })
    .select("*").single();
  if (error) { console.error("addOrderItem:", error); return { item: null, error: error.message }; }
  return { item: data as OrderItem, error: null };
}

export async function updateOrderItem(id: string, patch: OrderItemPatch): Promise<string | null> {
  const { error } = await supabase.from("purchase_order_items").update({ ...patch, updated_at: new Date().toISOString() }).eq("id", id);
  if (error) console.error("updateOrderItem:", error);
  return error?.message ?? null;
}

// 보류해 둔 줄을 오늘 주문으로 옮김 — 날짜 기준이 created_at 이라 지금 시각으로 바꾸고 보류 해제.
export async function moveOrderItemToToday(id: string): Promise<{ created_at: string | null; error: string | null }> {
  const now = new Date().toISOString();
  const { error } = await supabase.from("purchase_order_items")
    .update({ created_at: now, held_at: null, updated_at: now }).eq("id", id);
  if (error) { console.error("moveOrderItemToToday:", error); return { created_at: null, error: error.message }; }
  return { created_at: now, error: null };
}

// 자식 레코드가 이 테이블을 참조하는 곳이 없어서 완전삭제로 충분.
export async function deleteOrderItem(id: string): Promise<string | null> {
  const { error } = await supabase.from("purchase_order_items").delete().eq("id", id);
  if (error) console.error("deleteOrderItem:", error);
  return error?.message ?? null;
}
