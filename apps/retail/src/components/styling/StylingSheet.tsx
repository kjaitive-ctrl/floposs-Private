"use client";

import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import { styles } from "@/common/styles";
import { addOrderItem } from "@/lib/purchaseOrder";
import { formatComma, parseDigits } from "@/lib/format";

// 스타일링 시트 — 줄 = 코디 1벌. 메모 + 6칸(하의/상의·이너/상의·아우터/아우터/소품·가방/신발).
// 칸마다 후보 샘플 1개: 매장명·상품명·컬러·단가. 칸에서 나오면 자동 저장.
// [주문서로] → 주문 탭에 "샘플요청" 줄로 등록(수량 1). 입고되면 주문 탭에서 샘플 탭으로 자동 등록. 마이그 242.

const SLOTS = [
  { key: "bottom", label: "하의" },
  { key: "top_inner", label: "상의/이너" },
  { key: "top_outer", label: "상의/아우터" },
  { key: "outer", label: "아우터" },
  { key: "acc", label: "소품/가방" },
  { key: "shoes", label: "신발" },
] as const;
type SlotKey = typeof SLOTS[number]["key"];

type Look = { id: string; memo: string; sort_order: number };
type Cell = {
  id: string; look_id: string; slot: SlotKey;
  store_name: string | null; product_name: string | null; color: string | null; unit_price: number | null;
  order_item_id: string | null;
};
type OrderState = { received_quantity: number | null; sample_product_id: string | null };
type CellField = "store_name" | "product_name" | "color" | "unit_price";

const hasContent = (c?: Cell) => !!(c && (c.store_name?.trim() || c.product_name?.trim()));

export default function StylingSheet({ tenantId }: { tenantId: string }) {
  const [looks, setLooks] = useState<Look[]>([]);
  const [cells, setCells] = useState<Record<string, Cell>>({}); // `${look_id}:${slot}`
  const [orders, setOrders] = useState<Record<string, OrderState>>({}); // order_item_id → 상태
  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState<{ text: string; error?: boolean } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    const { data: ls, error: e1 } = await supabase.from("styling_looks")
      .select("id,memo,sort_order").eq("tenant_id", tenantId).is("deleted_at", null).order("sort_order");
    if (e1) { setMsg({ text: `불러오기 실패: ${e1.message}`, error: true }); setLoading(false); return; }
    const ids = (ls ?? []).map(l => l.id);
    const map: Record<string, Cell> = {};
    const ordMap: Record<string, OrderState> = {};
    if (ids.length) {
      const { data: cs, error: e2 } = await supabase.from("styling_cells")
        .select("id,look_id,slot,store_name,product_name,color,unit_price,order_item_id").in("look_id", ids);
      if (e2) { setMsg({ text: `불러오기 실패: ${e2.message}`, error: true }); setLoading(false); return; }
      (cs ?? []).forEach(c => { map[`${c.look_id}:${c.slot}`] = c as Cell; });
      const oids = (cs ?? []).map(c => c.order_item_id).filter(Boolean) as string[];
      if (oids.length) {
        const { data: os } = await supabase.from("purchase_order_items")
          .select("id,received_quantity,sample_product_id").in("id", oids);
        (os ?? []).forEach(o => { ordMap[o.id] = { received_quantity: o.received_quantity, sample_product_id: o.sample_product_id }; });
      }
    }
    setLooks(ls ?? []);
    setCells(map);
    setOrders(ordMap);
    setLoading(false);
  }, [tenantId]);

  useEffect(() => { load(); }, [load]);

  async function addLook() {
    const next = (looks.at(-1)?.sort_order ?? 0) + 10;
    const { data, error } = await supabase.from("styling_looks")
      .insert({ tenant_id: tenantId, memo: "", sort_order: next }).select("id,memo,sort_order").single();
    if (error || !data) { setMsg({ text: `코디 추가 실패: ${error?.message}`, error: true }); return; }
    setLooks(prev => [...prev, data]);
  }

  async function saveMemo(look: Look, memo: string) {
    if (memo === look.memo) return;
    setLooks(prev => prev.map(l => l.id === look.id ? { ...l, memo } : l));
    const { error } = await supabase.from("styling_looks")
      .update({ memo, updated_at: new Date().toISOString() }).eq("id", look.id);
    if (error) setMsg({ text: `메모 저장 실패: ${error.message}`, error: true });
  }

  async function removeLook(look: Look) {
    if (!confirm("이 코디 줄을 삭제할까요? (이미 주문서로 보낸 줄은 주문 탭에 그대로 남습니다)")) return;
    setLooks(prev => prev.filter(l => l.id !== look.id));
    const { error } = await supabase.from("styling_looks")
      .update({ deleted_at: new Date().toISOString() }).eq("id", look.id);
    if (error) setMsg({ text: `삭제 실패: ${error.message}`, error: true });
  }

  async function saveCell(lookId: string, slot: SlotKey, field: CellField, raw: string) {
    const k = `${lookId}:${slot}`;
    const cur = cells[k];
    const value: string | number | null = field === "unit_price"
      ? (parseDigits(raw) ? Number(parseDigits(raw)) : null)
      : (raw.trim() || null);
    if ((cur?.[field] ?? null) === value) return;
    if (!cur && value === null) return;
    const { data, error } = await supabase.from("styling_cells")
      .upsert({ tenant_id: tenantId, look_id: lookId, slot, [field]: value, updated_at: new Date().toISOString() },
        { onConflict: "look_id,slot" })
      .select("id,look_id,slot,store_name,product_name,color,unit_price,order_item_id").single();
    if (error || !data) { setMsg({ text: `저장 실패: ${error?.message}`, error: true }); return; }
    setCells(prev => ({ ...prev, [k]: data as Cell }));
  }

  // [주문서로] — 이 코디에서 아직 안 보낸 칸만 주문 탭에 샘플요청 줄로 (수량 1)
  async function sendToOrder(look: Look) {
    const targets = SLOTS.map(s => cells[`${look.id}:${s.key}`]).filter(c => hasContent(c) && !c!.order_item_id) as Cell[];
    if (targets.length === 0) { setMsg({ text: "주문서로 보낼 칸이 없습니다 (매장명이나 상품명이 있는 칸, 아직 안 보낸 칸만)" }); return; }
    setBusy(look.id);
    let sent = 0;
    for (const c of targets) {
      const name = c.product_name?.trim() || null;
      const { item, error } = await addOrderItem(tenantId, {
        product_name: name,
        wholesale_name: name,
        supplier_name: c.store_name?.trim() || null,
        variant_label: c.color?.trim() || null,
        unit_price: c.unit_price ?? 0,
        quantity: 1,
        is_sample_request: true,
        styling_cell_id: c.id,
      });
      if (error || !item) { setMsg({ text: `주문서 등록 실패: ${error}`, error: true }); break; }
      const { error: e2 } = await supabase.from("styling_cells").update({ order_item_id: item.id }).eq("id", c.id);
      if (e2) { setMsg({ text: `연결 저장 실패: ${e2.message}`, error: true }); break; }
      setCells(prev => ({ ...prev, [`${c.look_id}:${c.slot}`]: { ...c, order_item_id: item.id } }));
      setOrders(prev => ({ ...prev, [item.id]: { received_quantity: null, sample_product_id: null } }));
      sent++;
    }
    setBusy(null);
    if (sent) setMsg({ text: `주문 탭에 샘플요청 ${sent}줄 등록 — 입고하면 샘플 탭으로 넘어갑니다` });
  }

  function badge(c?: Cell) {
    if (!c?.order_item_id) return null;
    const o = orders[c.order_item_id];
    if (o?.sample_product_id) return <span className="text-[10px] px-1 rounded bg-emerald-50 text-emerald-700">샘플 등록됨</span>;
    if (o && (o.received_quantity ?? 0) > 0) return <span className="text-[10px] px-1 rounded bg-emerald-50 text-emerald-700">입고</span>;
    return <span className="text-[10px] px-1 rounded bg-yellow-100 text-yellow-800">주문됨</span>;
  }

  if (loading) return <div className="text-xs text-gray-400">불러오는 중…</div>;

  const inputCls = "w-full h-7 px-1.5 text-xs bg-transparent text-black placeholder:text-gray-400 focus:outline-none focus:bg-white focus:ring-1 focus:ring-black focus:ring-inset";

  return (
    <div>
      <div className="flex items-center gap-3 mb-4">
        <h1 className={styles.headerTitle}>스타일링</h1>
        <span className="text-xs text-gray-400">줄 = 코디 1벌 · 칸마다 후보 샘플 (매장명·상품명·컬러·단가) · [주문서로] → 주문 탭 샘플요청 → 입고 시 샘플 탭 등록</span>
      </div>
      {msg && <div className={(msg.error ? styles.msgError : styles.msgOk) + " mb-3"}>{msg.text}</div>}

      <div className="overflow-x-auto border-l border-t border-gray-300">
        <table className="border-collapse text-xs">
          <thead>
            <tr>
              <th rowSpan={2} className="min-w-[14rem] bg-gray-200 border-b border-r border-gray-300 font-semibold">메모</th>
              <th colSpan={SLOTS.length} className="h-7 bg-yellow-300 border-b border-r border-gray-300 font-semibold">스타일링</th>
              <th rowSpan={2} className="min-w-[6rem] bg-gray-100 border-b border-r border-gray-300 font-medium">주문</th>
            </tr>
            <tr>
              {SLOTS.map(s => (
                <th key={s.key} className="min-w-[13rem] h-7 bg-yellow-200 border-b border-r border-gray-300 font-semibold">{s.label}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {looks.map(look => (
              <tr key={look.id} className="align-top">
                <td className="p-0 border-b border-r border-gray-300 relative group">
                  <textarea defaultValue={look.memo} placeholder="메모"
                    onBlur={e => saveMemo(look, e.currentTarget.value)}
                    className="w-full h-[4.5rem] px-1.5 py-1 text-xs bg-transparent text-black resize-none focus:outline-none focus:bg-white focus:ring-1 focus:ring-black focus:ring-inset" />
                  <button type="button" onClick={() => removeLook(look)} title="이 코디 줄 삭제"
                    className="absolute right-1 bottom-1 hidden group-hover:block text-gray-400 hover:text-red-600">✕</button>
                </td>
                {SLOTS.map(s => {
                  const c = cells[`${look.id}:${s.key}`];
                  const locked = !!c?.order_item_id; // 주문서로 보낸 칸은 주문 탭에서 고침
                  return (
                    <td key={s.key} className={"p-0 border-b border-r border-gray-300 " + (locked ? "bg-yellow-50" : "bg-amber-50/60")}>
                      <div className="grid grid-cols-[1fr_5rem]">
                        <input defaultValue={c?.store_name ?? ""} placeholder="매장명" disabled={locked}
                          onBlur={e => saveCell(look.id, s.key, "store_name", e.currentTarget.value)} className={inputCls + " border-b border-r border-amber-100"} />
                        <input defaultValue={c?.color ?? ""} placeholder="컬러" disabled={locked}
                          onBlur={e => saveCell(look.id, s.key, "color", e.currentTarget.value)} className={inputCls + " border-b border-amber-100"} />
                        <input defaultValue={c?.product_name ?? ""} placeholder="상품명" disabled={locked}
                          onBlur={e => saveCell(look.id, s.key, "product_name", e.currentTarget.value)} className={inputCls + " border-b border-r border-amber-100"} />
                        <input defaultValue={c?.unit_price != null ? formatComma(c.unit_price) : ""} placeholder="단가" disabled={locked}
                          onBlur={e => saveCell(look.id, s.key, "unit_price", e.currentTarget.value)} className={inputCls + " border-b border-amber-100 text-right"} />
                      </div>
                      <div className="h-[1.1rem] px-1.5">{badge(c)}</div>
                    </td>
                  );
                })}
                <td className="px-2 py-2 border-b border-r border-gray-300 text-center">
                  <button type="button" disabled={busy === look.id} onClick={() => sendToOrder(look)}
                    className={styles.btnSmall + " bg-white whitespace-nowrap disabled:opacity-40"}>
                    {busy === look.id ? "보내는 중…" : "주문서로"}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <button type="button" onClick={addLook} className="mt-2 px-3 py-1 text-xs border border-gray-300 rounded hover:bg-gray-50">+ 코디 추가</button>
    </div>
  );
}
