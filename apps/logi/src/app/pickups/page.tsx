"use client";

import { useEffect, useState, useCallback, useMemo } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase";

// 오늘의 픽업 리스트 — order_notes(logi_tenant_id=나) 를 slot 그룹으로.
// 정렬: 건물(slot_buildings.sort) → 층 → 열(section) → 호(unit). 밤/낮 필터 = slots.category.
// 픽업 성공/실패 = order_notes.pickup_status 토글. 줄 펼치면 주문내역(items). [[project_logi_axis]]

type NoteItem = {
  id: string;
  consumer_product_name: string | null;
  supplier_product_name: string | null;
  consumer_option_label: string | null;
  supplier_option_label: string | null;
  quantity: number;
  shipped_quantity: number | null;
  ship_memo: string | null;
};
type SlotStore = { store_name: string; is_current: boolean };
type Slot = {
  building: string; floor: number; wing: string | null;
  section: string | null; unit: string; category: string | null;
  slot_stores: SlotStore[];
};
type Note = {
  id: string;
  sent_at: string;
  pickup_status: "pending" | "picked" | "failed";
  pickup_memo: string | null;
  is_test: boolean;
  recipient_slot_id: string;
  sender: { company_name: string; store_name: string | null } | null;
  slot: Slot | null;
  items: NoteItem[];
};

function floorLabel(f: number): string {
  return f < 0 ? `B${-f}` : `${f}F`;
}
function slotAddr(s: Slot): string {
  const sec = s.section ?? "";
  return `${s.building} ${floorLabel(s.floor)} ${sec}${s.unit}`.replace(/\s+/g, " ").trim();
}
function currentStore(s: Slot): string {
  return s.slot_stores.find(st => st.is_current)?.store_name
    ?? s.slot_stores[0]?.store_name
    ?? "(매장 미등록)";
}
function todayStr(): string {
  const d = new Date();
  const off = d.getTimezoneOffset() * 60000;
  return new Date(d.getTime() - off).toISOString().slice(0, 10);
}

export default function PickupsPage() {
  const router = useRouter();
  const [tenantId, setTenantId] = useState<string | null>(null);
  const [companyName, setCompanyName] = useState("");
  const [date, setDate] = useState(todayStr());
  const [marketFilter, setMarketFilter] = useState<"all" | "낮" | "밤">("all");
  const [statusFilter, setStatusFilter] = useState<"all" | "pending" | "picked" | "failed">("all");
  const [notes, setNotes] = useState<Note[]>([]);
  const [buildingSort, setBuildingSort] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  // 인증 게이트
  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      const meta = session?.user?.app_metadata as { user_type?: string; tenant_id?: string } | undefined;
      if (!session || meta?.user_type !== "logistics" || !meta?.tenant_id) {
        router.replace("/login");
        return;
      }
      setTenantId(meta.tenant_id);
      setCompanyName(session.user.user_metadata?.name ?? "");
    });
  }, [router]);

  // 건물 정렬맵 (1회)
  useEffect(() => {
    supabase.from("slot_buildings").select("name, sort").then(({ data }) => {
      const map: Record<string, number> = {};
      (data ?? []).forEach((b: { name: string; sort: number }) => { map[b.name] = b.sort; });
      setBuildingSort(map);
    });
  }, []);

  const fetchNotes = useCallback(async () => {
    if (!tenantId) return;
    setLoading(true);
    const start = new Date(`${date}T00:00:00`);
    const end = new Date(`${date}T23:59:59.999`);
    const { data, error } = await supabase
      .from("order_notes")
      .select(`
        id, sent_at, pickup_status, pickup_memo, is_test, recipient_slot_id,
        sender:tenants!sender_retail_tenant_id ( company_name, store_name ),
        slot:slots!recipient_slot_id ( building, floor, wing, section, unit, category, slot_stores ( store_name, is_current ) ),
        items:order_note_items ( id, consumer_product_name, supplier_product_name, consumer_option_label, supplier_option_label, quantity, shipped_quantity, ship_memo )
      `)
      .eq("logi_tenant_id", tenantId)
      .gte("sent_at", start.toISOString())
      .lte("sent_at", end.toISOString())
      .order("sent_at", { ascending: false });
    if (error) console.error("[pickups] load error:", error);
    setNotes((data as unknown as Note[]) ?? []);
    setLoading(false);
  }, [tenantId, date]);

  useEffect(() => { fetchNotes(); }, [fetchNotes]);

  async function setStatus(noteId: string, status: Note["pickup_status"]) {
    const next = status;
    setNotes(prev => prev.map(n => n.id === noteId ? { ...n, pickup_status: next } : n));
    const { error } = await supabase
      .from("order_notes")
      .update({ pickup_status: next, picked_at: next === "pending" ? null : new Date().toISOString() })
      .eq("id", noteId);
    if (error) { console.error("[pickups] update error:", error); fetchNotes(); }
  }

  function toggleExpand(id: string) {
    setExpanded(prev => {
      const s = new Set(prev);
      if (s.has(id)) s.delete(id); else s.add(id);
      return s;
    });
  }

  // 필터 + slot 그룹 + 정렬
  const groups = useMemo(() => {
    const filtered = notes.filter(n => {
      if (marketFilter !== "all" && n.slot?.category !== marketFilter) return false;
      if (statusFilter !== "all" && n.pickup_status !== statusFilter) return false;
      return true;
    });
    const bySlot = new Map<string, { slot: Slot | null; notes: Note[] }>();
    for (const n of filtered) {
      const key = n.recipient_slot_id;
      if (!bySlot.has(key)) bySlot.set(key, { slot: n.slot, notes: [] });
      bySlot.get(key)!.notes.push(n);
    }
    const arr = [...bySlot.values()];
    arr.sort((a, b) => {
      const sa = a.slot, sb = b.slot;
      if (!sa || !sb) return 0;
      const ba = buildingSort[sa.building] ?? 9999, bb = buildingSort[sb.building] ?? 9999;
      if (ba !== bb) return ba - bb;
      if (sa.building !== sb.building) return sa.building.localeCompare(sb.building, "ko");
      if (sa.floor !== sb.floor) return sa.floor - sb.floor;
      if ((sa.section ?? "") !== (sb.section ?? "")) return (sa.section ?? "").localeCompare(sb.section ?? "", "ko");
      return sa.unit.localeCompare(sb.unit, "ko", { numeric: true });
    });
    return arr;
  }, [notes, marketFilter, statusFilter, buildingSort]);

  const total = groups.reduce((s, g) => s + g.notes.length, 0);
  const done = notes.filter(n => n.pickup_status !== "pending").length;

  async function handleLogout() {
    await supabase.auth.signOut();
    router.replace("/login");
  }

  const statusTabs: { key: typeof statusFilter; label: string }[] = [
    { key: "all", label: "전체" },
    { key: "pending", label: "대기" },
    { key: "picked", label: "완료" },
    { key: "failed", label: "실패" },
  ];

  return (
    <div className="max-w-3xl mx-auto p-4 pb-20">
      {/* 헤더 */}
      <div className="flex items-center justify-between mb-4">
        <div>
          <h1 className="text-lg font-bold text-gray-900">오늘의 픽업</h1>
          <p className="text-xs text-gray-500">{companyName} · {total}건 (완료 {done})</p>
        </div>
        <button onClick={handleLogout} className="text-xs text-gray-400 hover:text-gray-700">로그아웃</button>
      </div>

      {/* 필터 */}
      <div className="flex flex-wrap items-center gap-2 mb-4">
        <input type="date" value={date} onChange={e => setDate(e.target.value)}
          className="px-3 py-1.5 border border-gray-300 rounded-lg text-sm" />
        <div className="flex rounded-lg border border-gray-300 overflow-hidden">
          {(["all", "낮", "밤"] as const).map(m => (
            <button key={m} onClick={() => setMarketFilter(m)}
              className={`px-3 py-1.5 text-sm ${marketFilter === m ? "bg-primary text-white" : "bg-white text-gray-600"}`}>
              {m === "all" ? "전체시장" : `${m}시장`}
            </button>
          ))}
        </div>
        <div className="flex rounded-lg border border-gray-300 overflow-hidden">
          {statusTabs.map(t => (
            <button key={t.key} onClick={() => setStatusFilter(t.key)}
              className={`px-3 py-1.5 text-sm ${statusFilter === t.key ? "bg-primary text-white" : "bg-white text-gray-600"}`}>
              {t.label}
            </button>
          ))}
        </div>
      </div>

      {/* 리스트 */}
      {loading ? (
        <p className="text-center text-sm text-gray-400 py-12">불러오는 중...</p>
      ) : groups.length === 0 ? (
        <p className="text-center text-sm text-gray-400 py-12">픽업할 주문이 없습니다.</p>
      ) : (
        <div className="space-y-3">
          {groups.map(g => (
            <div key={g.slot ? slotAddr(g.slot) + g.notes[0].id : g.notes[0].id}
              className="bg-white border border-gray-200 rounded-xl overflow-hidden">
              {/* slot 헤더 */}
              <div className="px-4 py-2.5 bg-gray-50 border-b border-gray-100 flex items-center justify-between">
                <div>
                  <span className="text-sm font-semibold text-gray-900">{g.slot ? slotAddr(g.slot) : "(주소 없음)"}</span>
                  <span className="ml-2 text-sm text-gray-600">{g.slot ? currentStore(g.slot) : ""}</span>
                </div>
                {g.slot?.category && (
                  <span className="text-[11px] px-2 py-0.5 rounded-full bg-primary-soft text-primary-hover">{g.slot.category}</span>
                )}
              </div>
              {/* retail 별 줄 */}
              {g.notes.map(n => {
                const isOpen = expanded.has(n.id);
                const qty = n.items.reduce((s, it) => s + it.quantity, 0);
                return (
                  <div key={n.id} className="border-b border-gray-100 last:border-0">
                    <div className="px-4 py-2.5 flex items-center justify-between gap-2">
                      <button onClick={() => toggleExpand(n.id)} className="flex-1 text-left">
                        <span className="text-sm font-medium text-gray-900">
                          {n.sender?.store_name || n.sender?.company_name || "거래처"}
                        </span>
                        <span className="ml-2 text-xs text-gray-500">{n.items.length}품목 · {qty}개 {isOpen ? "▲" : "▼"}</span>
                        {n.is_test && <span className="ml-2 text-[10px] px-1.5 py-0.5 bg-yellow-100 text-yellow-700 rounded">TEST</span>}
                      </button>
                      <div className="flex gap-1">
                        <button onClick={() => setStatus(n.id, n.pickup_status === "picked" ? "pending" : "picked")}
                          className={`text-xs px-2.5 py-1 rounded-lg border ${
                            n.pickup_status === "picked"
                              ? "bg-primary text-white border-primary"
                              : "bg-white text-gray-600 border-gray-300 hover:bg-gray-50"}`}>
                          ✓ 픽업
                        </button>
                        <button onClick={() => setStatus(n.id, n.pickup_status === "failed" ? "pending" : "failed")}
                          className={`text-xs px-2.5 py-1 rounded-lg border ${
                            n.pickup_status === "failed"
                              ? "bg-red-500 text-white border-red-500"
                              : "bg-white text-gray-600 border-gray-300 hover:bg-gray-50"}`}>
                          ✕ 실패
                        </button>
                      </div>
                    </div>
                    {/* 주문내역 */}
                    {isOpen && (
                      <div className="px-4 pb-3 bg-gray-50/50">
                        <table className="w-full text-xs">
                          <thead className="text-gray-400">
                            <tr>
                              <th className="text-left py-1 font-normal">상품(내/공급사)</th>
                              <th className="text-left py-1 font-normal">옵션</th>
                              <th className="text-right py-1 font-normal">수량</th>
                              <th className="text-left py-1 font-normal pl-2">도매회신</th>
                            </tr>
                          </thead>
                          <tbody>
                            {n.items.map(it => (
                              <tr key={it.id} className="border-t border-gray-100">
                                <td className="py-1 text-gray-800">
                                  {it.consumer_product_name || it.supplier_product_name || "-"}
                                  {it.supplier_product_name && it.consumer_product_name && (
                                    <span className="text-gray-400"> / {it.supplier_product_name}</span>
                                  )}
                                </td>
                                <td className="py-1 text-gray-600">{it.consumer_option_label || it.supplier_option_label || "-"}</td>
                                <td className="py-1 text-right text-gray-800">{it.quantity}</td>
                                <td className="py-1 pl-2 text-gray-600">
                                  {it.shipped_quantity != null ? `출고 ${it.shipped_quantity}` : ""}
                                  {it.ship_memo ? <span className="text-amber-600"> {it.ship_memo}</span> : ""}
                                  {it.shipped_quantity == null && !it.ship_memo ? <span className="text-gray-300">대기</span> : ""}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
