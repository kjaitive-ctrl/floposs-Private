"use client";

import { useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { supabase } from "@/lib/supabase";
import { today, formatSku, formatOrderTime } from "@/lib/format";
import { useTenantId } from "@/lib/useTenant";
import type { Customer as FullCustomer } from "@/lib/types";
import TabNavigation from "../_components/TabNavigation";
import SearchBox, { type Suggestion } from "../_components/SearchBox";
import { DataTable, TableHead, Th, Badge, EmptyRow, LoadingRow, PageHeader, TablePagination } from "../_components/DataTable";
import Button from "../_components/Button";

type StockStatus = "active" | "sale" | "inactive";  // 진행 / 세일 / 품절
type StockRow = {
  variant_id: string; product_no: number | null; sku: string;
  quantity: number;       // 현재 재고
  backorder_qty: number;  // 미송 잔여 (process_type='backorder' AND status='unshipped' 합계)
  hold_qty: number;       // 보류 잔여 (process_type='hold' AND status='unshipped' 합계)
  product_name: string; color: string; size: string;
  status: StockStatus;
};
type Customer = Pick<FullCustomer, "id" | "company_name">;
type InboundItemLog = { id: string; changed_field: string; old_value: string | null; new_value: string | null; changed_at: string };
type InboundItem = {
  id: string; variant_id: string; quantity: number; unit_price: number;
  inbound_item_logs: InboundItemLog[];
  product_variants: { color: string | null; size: string | null; products: { name: string } | null } | null;
};
type InboundOrder = {
  id: string; inbound_date: string; memo: string | null; total_amount: number; supplier_id: string | null;
  customers: { company_name: string } | null;
  inbound_items: InboundItem[];
};
type ReceiveRow = { variant_id: string; product_no: number | null; sku: string; product_name: string; color: string; size: string; current_qty: number; inbound_qty: string; unit_price: string };
type Tab = "register" | "history" | "stock" | "logs";

type LogRow = {
  id: string;
  qty_change: number;
  balance_after: number;
  reason: string;
  created_at: string;
  order_item_id: string | null;
  inbound_item_id: string | null;
  product_variants: { color: string | null; size: string | null; products: { name: string } | null } | null;
  order_items: { orders: { order_number: string; customers: { company_name: string } | null } | null } | null;
  inbound_items: { inbound_orders: { customers: { company_name: string } | null } | null } | null;
};

const LOGS_PAGE_SIZE = 50;

export default function InventoryPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [tab, setTab] = useState<Tab>((searchParams.get("tab") as Tab) ?? "register");
  const tenantId = useTenantId();

  const [customers, setCustomers] = useState<Customer[]>([]);
  const [variants, setVariants] = useState<ReceiveRow[]>([]);
  const [inboundDate, setInboundDate] = useState(() => today());
  const [supplierId, setSupplierId] = useState("");
  const [memo, setMemo] = useState("");
  const [search, setSearch] = useState("");
  const [registerSuggestions, setRegisterSuggestions] = useState<Suggestion[]>([]);
  const [saving, setSaving] = useState(false);

  const [inboundOrders, setInboundOrders] = useState<InboundOrder[]>([]);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [editingItem, setEditingItem] = useState<{ id: string; increase: string; decrease: string; price: string; originalQty: number } | null>(null);

  const [stock, setStock] = useState<StockRow[]>([]);
  const [stockSearch, setStockSearch] = useState("");
  const [stockSuggestions, setStockSuggestions] = useState<Suggestion[]>([]);
  const [loadingStock, setLoadingStock] = useState(false);

  const [logs, setLogs] = useState<LogRow[]>([]);
  const [logsPage, setLogsPage] = useState(0);
  const [logsTotal, setLogsTotal] = useState(0);
  const [logsFrom, setLogsFrom] = useState(today);
  const [logsTo, setLogsTo] = useState(today);
  const [loadingLogs, setLoadingLogs] = useState(false);
  const [logsSearch, setLogsSearch] = useState("");
  const [logsSuggestions, setLogsSuggestions] = useState<Suggestion[]>([]);

  useEffect(() => {
    if (!tenantId) return;
    fetchCustomers(tenantId);
    fetchVariants(tenantId);
  }, [tenantId]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (tab === "history" && tenantId) fetchInboundOrders(tenantId);
    if (tab === "stock" && tenantId) fetchStock(tenantId);
  }, [tab, tenantId]);

  async function fetchLogs(tid: string, from: string, to: string, page: number, search = logsSearch) {
    setLoadingLogs(true);
    const fromTs = from + "T00:00:00+09:00";
    const toTs   = to   + "T23:59:59+09:00";
    const start  = page * LOGS_PAGE_SIZE;

    // 검색어가 있으면 매칭되는 variant_id 목록 먼저 추출
    let variantFilter: string[] | null = null;
    if (search.trim()) {
      const q = search.trim().toLowerCase();
      variantFilter = variants
        .filter(r => `${r.product_name} ${r.color} / ${r.size}`.toLowerCase().includes(q))
        .map(r => r.variant_id);
      if (variantFilter.length === 0) {
        setLogs([]); setLogsTotal(0); setLoadingLogs(false); return;
      }
    }

    let query = supabase
      .from("inventory_logs")
      .select(`
        id, qty_change, balance_after, reason, created_at, order_item_id, inbound_item_id,
        product_variants(color, size, products(name)),
        order_items(orders(order_number, customers(company_name))),
        inbound_items(inbound_orders(customers(company_name)))
      `, { count: "exact" })
      .eq("tenant_id", tid)
      .gte("created_at", fromTs)
      .lte("created_at", toTs)
      .order("created_at", { ascending: false })
      .range(start, start + LOGS_PAGE_SIZE - 1);

    if (variantFilter) query = query.in("variant_id", variantFilter);

    const { data, count, error } = await query;

    if (!error) {
      setLogs((data as unknown as LogRow[]) ?? []);
      setLogsTotal(count ?? 0);
    }
    setLoadingLogs(false);
  }

  async function fetchCustomers(tid: string) {
    const { data } = await supabase.from("customers").select("id, company_name").eq("tenant_id", tid).order("company_name");
    if (data) setCustomers(data);
  }

  async function fetchVariants(tid: string) {
    const [{ data: variantData }, { data: invData }] = await Promise.all([
      supabase.from("product_variants").select("id, sku, color, size, products!inner(name, product_no)").eq("is_active", true).eq("products.tenant_id", tid).order("id"),
      supabase.from("inventory").select("variant_id, quantity").eq("tenant_id", tid),
    ]);
    const invMap: Record<string, number> = {};
    invData?.forEach(r => { invMap[r.variant_id] = r.quantity; });
    if (variantData) {
      setVariants(variantData.map(v => ({
        variant_id: v.id,
        product_no: (v.products as unknown as { name: string; product_no: number | null } | null)?.product_no ?? null,
        sku: v.sku || "-",
        product_name: (v.products as unknown as { name: string; product_no: number | null } | null)?.name || "-",
        color: v.color || "-", size: v.size || "-",
        current_qty: invMap[v.id] || 0,
        inbound_qty: "", unit_price: "",
      })));
    }
  }

  async function fetchInboundOrders(tid: string) {
    const { data } = await supabase.from("inbound_orders")
      .select(`id, inbound_date, memo, total_amount, supplier_id, customers(company_name),
        inbound_items(id, variant_id, quantity, unit_price,
          product_variants(sku, color, size, products(name, product_no)),
          inbound_item_logs(id, changed_field, old_value, new_value, changed_at))`)
      .eq("tenant_id", tid)
      .order("inbound_date", { ascending: false })
      .limit(100);
    if (data) setInboundOrders(data as unknown as InboundOrder[]);
  }

  async function fetchStock(tid: string) {
    setLoadingStock(true);
    const [{ data: variantData }, { data: invData }, { data: pendingData }] = await Promise.all([
      // variant 단위 status (is_active, is_sale) — 옵션별 토글
      supabase.from("product_variants")
        .select("id, sku, color, size, is_active, is_sale, products!inner(name, product_no)")
        .eq("products.tenant_id", tid)
        .order("id"),
      supabase.from("inventory")
        .select("variant_id, quantity")
        .eq("tenant_id", tid),
      // 미송/보류 잔여 합계 — process_type 별로 분리 누적
      supabase.from("order_items")
        .select("variant_id, remaining_qty, process_type, orders!inner(tenant_id)")
        .eq("orders.tenant_id", tid)
        .in("process_type", ["backorder", "hold"])
        .eq("status", "unshipped"),
    ]);
    const invMap: Record<string, number> = {};
    invData?.forEach(r => { invMap[r.variant_id] = r.quantity; });
    const backorderMap: Record<string, number> = {};
    const holdMap: Record<string, number> = {};
    (pendingData ?? []).forEach((r: { variant_id: string; remaining_qty: number; process_type: string }) => {
      const map = r.process_type === "hold" ? holdMap : backorderMap;
      map[r.variant_id] = (map[r.variant_id] ?? 0) + (r.remaining_qty ?? 0);
    });
    if (variantData) {
      setStock(variantData.map(v => {
        const vv = v as unknown as { id: string; sku: string | null; color: string | null; size: string | null; is_active: boolean; is_sale: boolean };
        const p = v.products as unknown as { name: string; product_no: number | null } | null;
        const status: StockStatus = !vv.is_active ? "inactive" : vv.is_sale ? "sale" : "active";
        return {
          variant_id: vv.id,
          product_no: p?.product_no ?? null,
          sku: vv.sku || "-",
          quantity: invMap[vv.id] || 0,
          backorder_qty: backorderMap[vv.id] || 0,
          hold_qty: holdMap[vv.id] || 0,
          product_name: p?.name || "-",
          color: vv.color || "-",
          size: vv.size || "-",
          status,
        };
      }));
    }
    setLoadingStock(false);
  }

  async function setVariantStatus(variantId: string, status: StockStatus) {
    const update = status === "active"   ? { is_active: true,  is_sale: false }
                : status === "sale"     ? { is_active: true,  is_sale: true  }
                                        : { is_active: false, is_sale: false };  // inactive (품절)
    const { error } = await supabase.from("product_variants").update(update).eq("id", variantId);
    if (error) { alert("상태 변경 실패: " + error.message); return; }
    setStock(prev => prev.map(r => r.variant_id === variantId ? { ...r, status } : r));
  }

  function updateRow(index: number, field: "inbound_qty" | "unit_price", value: string) {
    setVariants(prev => prev.map((r, i) => i === index ? { ...r, [field]: value } : r));
  }

  async function handleSave() {
    const toSave = variants.filter(r => r.inbound_qty !== "" && parseInt(r.inbound_qty) > 0);
    if (toSave.length === 0) { alert("입고할 수량을 입력해주세요."); return; }
    if (!tenantId) return;
    setSaving(true);

    const totalAmount = toSave.reduce((s, r) => s + (parseInt(r.inbound_qty) * parseInt(r.unit_price || "0")), 0);
    const { data: order, error: orderErr } = await supabase.from("inbound_orders")
      .insert({ tenant_id: tenantId, inbound_date: inboundDate, supplier_id: supplierId || null, memo: memo || null, total_amount: totalAmount })
      .select("id").single();
    if (orderErr || !order) { alert("저장 실패"); setSaving(false); return; }

    const { data: insertedItems } = await supabase.from("inbound_items").insert(
      toSave.map(r => ({ inbound_order_id: order.id, variant_id: r.variant_id, quantity: parseInt(r.inbound_qty), unit_price: parseInt(r.unit_price || "0") }))
    ).select("id, variant_id");
    const inboundItemIdMap: Record<string, string> = {};
    (insertedItems ?? []).forEach(r => { inboundItemIdMap[r.variant_id] = r.id; });

    // 한 번에 기존 재고 조회 후 upsert (N*2 쿼리 → 2 쿼리)
    const variantIds = toSave.map(r => r.variant_id);
    const { data: existingInv } = await supabase
      .from("inventory").select("variant_id, quantity")
      .eq("tenant_id", tenantId).in("variant_id", variantIds);
    const existingMap = new Map(existingInv?.map(r => [r.variant_id, r.quantity]) ?? []);
    await supabase.from("inventory").upsert(
      toSave.map(r => ({
        tenant_id: tenantId,
        variant_id: r.variant_id,
        quantity: (existingMap.get(r.variant_id) ?? 0) + parseInt(r.inbound_qty),
        updated_at: new Date().toISOString(),
      })),
      { onConflict: "tenant_id,variant_id" }
    );

    // 재고증가 로그
    await supabase.from("inventory_logs").insert(
      toSave.map(r => ({
        tenant_id: tenantId,
        variant_id: r.variant_id,
        inbound_item_id: inboundItemIdMap[r.variant_id] ?? null,
        qty_change: parseInt(r.inbound_qty),
        balance_after: (existingMap.get(r.variant_id) ?? 0) + parseInt(r.inbound_qty),
        reason: "receipt",
      }))
    );

    setVariants(prev => prev.map(r => ({ ...r, inbound_qty: "", unit_price: "" })));
    setMemo(""); setSupplierId(""); setSaving(false);
    alert("입고 처리가 완료되었습니다.");
    fetchVariants(tenantId);
  }

  async function saveItemEdit(item: InboundItem) {
    if (!editingItem) return;
    const increase = parseInt(editingItem.increase) || 0;
    const decrease = parseInt(editingItem.decrease) || 0;
    const newPrice = parseInt(editingItem.price);
    if (increase < 0 || decrease < 0) { alert("0 이상의 값을 입력해주세요."); return; }

    const diff = increase - decrease;
    const newQty = item.quantity + diff;

    const logs = [];
    if (diff !== 0) logs.push({ inbound_item_id: item.id, changed_field: "수량", old_value: String(item.quantity), new_value: String(newQty) });
    if (newPrice !== item.unit_price) logs.push({ inbound_item_id: item.id, changed_field: "납품단가", old_value: String(item.unit_price), new_value: String(newPrice) });

    // 077 closed-session guard: 정산완료 세션의 입고 항목 수정 차단 → 사장 안내 필수
    const { error: itemErr } = await supabase.from("inbound_items").update({ quantity: newQty, unit_price: newPrice }).eq("id", item.id);
    if (itemErr) { alert("입고 수정 오류: " + itemErr.message); setEditingItem(null); return; }
    if (logs.length > 0) await supabase.from("inbound_item_logs").insert(logs);
    if (diff !== 0 && tenantId) {
      const { data: inv } = await supabase.from("inventory").select("quantity").eq("tenant_id", tenantId).eq("variant_id", item.variant_id).single();
      if (inv) {
        const newBalance = inv.quantity + diff;
        await supabase.from("inventory").update({ quantity: newBalance }).eq("tenant_id", tenantId).eq("variant_id", item.variant_id);
        await supabase.from("inventory_logs").insert({
          tenant_id: tenantId,
          variant_id: item.variant_id,
          inbound_item_id: item.id,
          qty_change: diff,
          balance_after: newBalance,
          reason: "adjustment",
        });
      }
    }

    setEditingItem(null);
    if (tenantId) fetchInboundOrders(tenantId);
  }

  function handleRegisterQueryChange(q: string) {
    if (!q.trim()) { setRegisterSuggestions([]); return; }
    const seen = new Set<string>();
    const items: Suggestion[] = [];
    variants.forEach(r => {
      if (r.product_name.toLowerCase().includes(q.toLowerCase()) && !seen.has(r.product_name)) {
        seen.add(r.product_name); items.push({ text: r.product_name });
      }
    });
    setRegisterSuggestions(items.slice(0, 8));
  }

  function handleStockQueryChange(q: string) {
    if (!q.trim()) { setStockSuggestions([]); return; }
    const seen = new Set<string>();
    const items: Suggestion[] = [];
    stock.forEach(r => {
      if (r.product_name.toLowerCase().includes(q.toLowerCase()) && !seen.has(r.product_name)) {
        seen.add(r.product_name); items.push({ text: r.product_name });
      }
    });
    setStockSuggestions(items.slice(0, 8));
  }

  const filteredVariants = variants.filter(r =>
    r.product_name.includes(search) || r.color.includes(search) || r.size.includes(search)
  );
  const filteredStock = stock.filter(r =>
    r.product_name.includes(stockSearch) || r.color.includes(stockSearch) || r.size.includes(stockSearch)
  );

  return (
    <div>
      <PageHeader title="재고 관리" />

      <TabNavigation
        tabs={[
          { key: "register", label: "입고 등록" },
          { key: "history", label: "입고 내역" },
          { key: "stock", label: "재고 현황" },
          { key: "logs", label: "입출고 내역" },
        ]}
        active={tab}
        onChange={k => { setTab(k as Tab); router.replace(`/dashboard/inventory?tab=${k}`); }}
      />

      {/* 입고 등록 탭 */}
      {tab === "register" && (
        <div>
          <div className="bg-white rounded-xl border border-gray-200 p-5 mb-5">
            <div className="grid grid-cols-3 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">입고일자</label>
                <input type="date" value={inboundDate} onChange={e => setInboundDate(e.target.value)}
                  className="w-full input-md" />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">입고처 <span className="text-gray-400 font-normal">(선택)</span></label>
                <select value={supplierId} onChange={e => setSupplierId(e.target.value)}
                  className="w-full input-md">
                  <option value="">선택 안함</option>
                  {customers.map(c => <option key={c.id} value={c.id}>{c.company_name}</option>)}
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">메모</label>
                <input type="text" value={memo} onChange={e => setMemo(e.target.value)} placeholder="메모 입력"
                  className="w-full input-md" />
              </div>
            </div>
          </div>

          <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
            <div className="flex items-center justify-between px-5 py-3 border-b border-gray-100">
              <p className="text-sm font-medium text-gray-700">상품 목록 <span className="text-gray-400 ml-1">수량 입력 후 확인</span></p>
              <SearchBox
                placeholder="상품명, 색상, 사이즈 검색"
                onSearch={setSearch}
                onQueryChange={handleRegisterQueryChange}
                suggestions={registerSuggestions}
                inputWidth="w-56"
              />
            </div>
            <div className="overflow-x-auto max-h-[480px] overflow-y-auto">
              <table className="w-full text-sm">
                <TableHead>
                  <Th className="w-24 text-gray-500">SKU</Th>
                  <Th className="text-left">상품명</Th>
                  <Th className="w-24">색상</Th>
                  <Th className="w-20">사이즈</Th>
                  <Th className="text-right w-24">현재재고</Th>
                  <Th className="w-32">입고수량</Th>
                  <Th className="w-36">납품단가</Th>
                </TableHead>
                <tbody>
                  {filteredVariants.length === 0 ? (
                    <EmptyRow colSpan={7} message="상품이 없습니다." />
                  ) : filteredVariants.map(r => {
                    const realIdx = variants.findIndex(v => v.variant_id === r.variant_id);
                    const hasQty = r.inbound_qty !== "" && parseInt(r.inbound_qty) > 0;
                    return (
                      <tr key={r.variant_id} className={`border-b border-gray-100 ${hasQty ? "bg-primary-soft" : "hover:bg-gray-50"}`}>
                        <td className="px-3 py-2.5 text-center text-gray-400 font-mono text-xs">{formatSku(r.product_no, r.sku)}</td>
                        <td className="px-4 py-2.5 font-medium text-gray-800">{r.product_name}</td>
                        <td className="px-3 py-2.5 text-center text-gray-600">{r.color}</td>
                        <td className="px-3 py-2.5 text-center text-gray-600">{r.size}</td>
                        <td className={`px-4 py-2.5 text-right font-medium ${r.current_qty === 0 ? "text-gray-400" : "text-gray-800"}`}>
                          {r.current_qty.toLocaleString()}
                        </td>
                        <td className="px-4 py-2.5 text-center">
                          <input type="number" min="0" value={r.inbound_qty} placeholder="0"
                            onChange={e => updateRow(realIdx, "inbound_qty", e.target.value)}
                            className="w-24 text-center px-2 py-1 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary-ring" />
                        </td>
                        <td className="px-4 py-2.5 text-center">
                          <input type="number" min="0" value={r.unit_price} placeholder="0"
                            onChange={e => updateRow(realIdx, "unit_price", e.target.value)}
                            className="w-32 text-center px-2 py-1 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary-ring" />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div className="px-5 py-4 border-t border-gray-100 bg-gray-50 flex items-center justify-between">
              <div className="text-sm text-gray-600">
                입고항목: <span className="font-semibold text-gray-900">
                  {variants.filter(r => r.inbound_qty !== "" && parseInt(r.inbound_qty) > 0).length}개
                </span>
                <span className="mx-3 text-gray-300">|</span>
                납품총액: <span className="font-semibold text-gray-900">
                  {variants.reduce((s, r) => s + (parseInt(r.inbound_qty || "0") * parseInt(r.unit_price || "0")), 0).toLocaleString()}원
                </span>
              </div>
              <Button size="lg" onClick={handleSave} disabled={saving}>
                {saving ? "처리중..." : "입고 확인"}
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* 입고 내역 탭 */}
      {tab === "history" && (
        <div className="space-y-4">
          {inboundOrders.length === 0 ? (
            <div className="bg-white rounded-xl border border-gray-200 p-10 text-center text-gray-400">입고 내역이 없습니다.</div>
          ) : inboundOrders.map(order => {
            const isOpen = expanded.has(order.id);
            return (
              <div key={order.id} className="bg-white rounded-xl border border-gray-200 overflow-hidden">
                <div className="flex items-center justify-between px-5 py-4 cursor-pointer hover:bg-gray-50"
                  onClick={() => setExpanded(prev => {
                    const next = new Set(prev);
                    if (next.has(order.id)) next.delete(order.id);
                    else next.add(order.id);
                    return next;
                  })}>
                  <div className="flex items-center gap-6">
                    <span className="text-sm font-semibold text-gray-800">{order.inbound_date}</span>
                    <span className="text-sm text-gray-600">
                      {(order.customers as { company_name: string } | null)?.company_name || "입고처 미지정"}
                    </span>
                    {order.memo && <span className="text-sm text-gray-400">{order.memo}</span>}
                  </div>
                  <div className="flex items-center gap-4">
                    <span className="text-sm font-medium text-gray-900">{order.total_amount.toLocaleString()}원</span>
                    <span className="text-gray-400 text-xs">{isOpen ? "▲" : "▼"}</span>
                  </div>
                </div>
                {isOpen && (
                  <div className="border-t border-gray-100">
                    <table className="w-full text-sm">
                      <TableHead>
                        <Th className="w-24 text-gray-400">SKU</Th>
                        <Th className="text-left">상품명</Th>
                        <Th>색상</Th>
                        <Th>사이즈</Th>
                        <Th className="w-28">수량</Th>
                        <Th className="w-32">납품단가</Th>
                        <Th className="text-right">금액</Th>
                        <Th className="w-16"></Th>
                      </TableHead>
                      <tbody>
                        {order.inbound_items.map(item => {
                          const v = item.product_variants;
                          const isEditing = editingItem?.id === item.id;
                          return (
                            <>
                              <tr key={item.id} className="border-t border-gray-100 hover:bg-gray-50">
                                <td className="px-3 py-2.5 text-center text-gray-400 font-mono text-xs">{formatSku((v?.products as { product_no?: number } | null)?.product_no, (v as { sku?: string } | null)?.sku)}</td>
                                <td className="px-4 py-2.5 text-gray-800">{(v?.products as { name: string } | null)?.name || "-"}</td>
                                <td className="px-3 py-2.5 text-center text-gray-600">{v?.color || "-"}</td>
                                <td className="px-3 py-2.5 text-center text-gray-600">{v?.size || "-"}</td>
                                <td className="px-3 py-2.5 text-center">
                                  {isEditing ? (
                                    <div className="flex flex-col items-center gap-1">
                                      <div className="flex items-center gap-1">
                                        <span className="text-xs text-emerald-600">+</span>
                                        <input type="number" min="0" value={editingItem.increase}
                                          onChange={e => setEditingItem(p => p ? { ...p, increase: e.target.value } : p)}
                                          className="w-14 text-center px-1 py-0.5 border border-emerald-300 rounded text-xs focus:outline-none" />
                                      </div>
                                      <div className="flex items-center gap-1">
                                        <span className="text-xs text-red-500">−</span>
                                        <input type="number" min="0" value={editingItem.decrease}
                                          onChange={e => setEditingItem(p => p ? { ...p, decrease: e.target.value } : p)}
                                          className="w-14 text-center px-1 py-0.5 border border-red-300 rounded text-xs focus:outline-none" />
                                      </div>
                                      <div className="flex items-center gap-1 text-xs text-gray-400">
                                        <span>{item.quantity}</span>
                                        <span>→</span>
                                        <span className="font-medium text-gray-700">
                                          {item.quantity + (parseInt(editingItem.increase) || 0) - (parseInt(editingItem.decrease) || 0)}
                                        </span>
                                      </div>
                                    </div>
                                  ) : <span className="font-medium">{item.quantity}</span>}
                                </td>
                                <td className="px-3 py-2.5 text-center">
                                  {isEditing ? (
                                    <input type="number" value={editingItem.price}
                                      onChange={e => setEditingItem(p => p ? { ...p, price: e.target.value } : p)}
                                      className="w-28 text-center px-2 py-1 border border-primary-ring rounded text-sm focus:outline-none" />
                                  ) : <span>{item.unit_price.toLocaleString()}원</span>}
                                </td>
                                <td className="px-4 py-2.5 text-right font-medium">{(item.quantity * item.unit_price).toLocaleString()}원</td>
                                <td className="px-3 py-2.5 text-center">
                                  {isEditing ? (
                                    <div className="flex gap-1">
                                      <button onClick={() => saveItemEdit(item)}
                                        className="px-2 py-1 bg-primary text-white text-xs rounded hover:bg-primary-hover">저장</button>
                                      <button onClick={() => setEditingItem(null)}
                                        className="px-2 py-1 bg-gray-200 text-gray-600 text-xs rounded hover:bg-gray-300">취소</button>
                                    </div>
                                  ) : (
                                    <button onClick={() => setEditingItem({ id: item.id, increase: "0", decrease: "0", price: String(item.unit_price), originalQty: item.quantity })}
                                      className="px-2 py-1 text-xs text-primary hover:bg-primary-soft rounded">수정</button>
                                  )}
                                </td>
                              </tr>
                              {item.inbound_item_logs?.length > 0 && (
                                <tr key={`${item.id}-logs`} className="bg-yellow-50">
                                  <td colSpan={7} className="px-6 py-2">
                                    <div className="flex flex-wrap gap-3">
                                      {item.inbound_item_logs.map(log => (
                                        <span key={log.id} className="text-xs text-yellow-700">
                                          [{new Date(log.changed_at).toLocaleString("ko-KR", { timeZone: "Asia/Seoul", month: "numeric", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false })}] {log.changed_field}: {log.old_value} → {log.new_value}
                                        </span>
                                      ))}
                                    </div>
                                  </td>
                                </tr>
                              )}
                            </>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* 입출고 내역 탭 */}
      {tab === "logs" && (
        <div>
          <div className="flex items-center gap-2 mb-3">
            <input type="date" value={logsFrom} onChange={e => setLogsFrom(e.target.value)}
              className="input-sm" />
            <span className="text-gray-400 text-sm">~</span>
            <input type="date" value={logsTo} onChange={e => setLogsTo(e.target.value)}
              className="input-sm" />
            <SearchBox
              placeholder="상품명, 색상, 사이즈"
              inputWidth="w-44"
              initialValue={logsSearch}
              suggestions={logsSuggestions}
              onQueryChange={q => {
                setLogsSearch(q);
                if (!q.trim()) { setLogsSuggestions([]); return; }
                const ql = q.toLowerCase();
                const items: Suggestion[] = [];
                variants.forEach(r => {
                  const label = `${r.product_name} ${r.color} / ${r.size}`;
                  if (label.toLowerCase().includes(ql)) items.push({ text: label });
                });
                setLogsSuggestions(items.slice(0, 10));
              }}
              onSearch={q => { setLogsSearch(q); setLogsPage(0); fetchLogs(tenantId!, logsFrom, logsTo, 0, q); }}
            />
            <Button size="sm" onClick={() => { setLogsPage(0); fetchLogs(tenantId!, logsFrom, logsTo, 0, logsSearch); }}>조회</Button>
            <span className="ml-auto text-xs text-gray-400">{logsTotal}건</span>
          </div>

          <DataTable
            maxHeight="calc(100vh-280px)"
            footer={
              <TablePagination
                page={logsPage}
                totalPages={Math.ceil(logsTotal / LOGS_PAGE_SIZE)}
                total={logsTotal}
                onPage={p => { setLogsPage(p); fetchLogs(tenantId!, logsFrom, logsTo, p); }}
              />
            }
          >
            <TableHead>
              <Th>일시</Th>
              <Th>구분</Th>
              <Th className="text-left">상품명</Th>
              <Th>색상</Th>
              <Th>사이즈</Th>
              <Th className="text-left">거래처</Th>
              <Th className="text-left">주문번호</Th>
              <Th className="text-right">변동</Th>
              <Th className="text-right">잔액</Th>
            </TableHead>
            <tbody>
              {loadingLogs ? (
                <LoadingRow colSpan={9} />
              ) : logs.length === 0 ? (
                <EmptyRow colSpan={9} message="조회 버튼을 눌러 검색하세요." />
              ) : logs.map(log => {
                const isOut = log.qty_change < 0;
                const logLabel =
                  log.reason === "shipment"   ? { text: "출고",    color: "blue" as const } :
                  log.reason === "adjustment" ? { text: "조정",    color: "gray" as const } :
                  log.reason === "undo"       ? { text: "취소",    color: "red" as const } :
                  log.order_item_id           ? { text: "반품/교환", color: "emerald" as const } :
                                                { text: "납품입고", color: "orange" as const };
                const order = log.order_items?.orders;
                const companyName =
                  order?.customers?.company_name ??
                  log.inbound_items?.inbound_orders?.customers?.company_name ??
                  null;
                return (
                  <tr key={log.id} className="border-b border-gray-100 hover:bg-gray-50">
                    <td className="px-3 py-2.5 text-center text-xs text-gray-500 whitespace-nowrap">
                      {formatOrderTime(log.created_at)}
                    </td>
                    <td className="px-3 py-2.5 text-center">
                      <Badge color={logLabel.color}>{logLabel.text}</Badge>
                    </td>
                    <td className="px-4 py-2.5 text-xs font-medium text-gray-800">{log.product_variants?.products?.name ?? "-"}</td>
                    <td className="px-3 py-2.5 text-center text-xs text-gray-600">{log.product_variants?.color ?? "-"}</td>
                    <td className="px-3 py-2.5 text-center text-xs text-gray-600">{log.product_variants?.size ?? "-"}</td>
                    <td className="px-4 py-2.5 text-xs text-gray-700">{companyName ?? "-"}</td>
                    <td className="px-4 py-2.5 text-xs text-gray-500">{order?.order_number ?? "-"}</td>
                    <td className={`px-4 py-2.5 text-right text-xs font-bold ${isOut ? "text-red-500" : "text-emerald-600"}`}>
                      {isOut ? "" : "+"}{log.qty_change.toLocaleString()}
                    </td>
                    <td className="px-4 py-2.5 text-right text-xs text-gray-700">{log.balance_after.toLocaleString()}</td>
                  </tr>
                );
              })}
            </tbody>
          </DataTable>
        </div>
      )}

      {/* 재고 현황 탭 */}
      {tab === "stock" && (
        <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
          <div className="flex items-center justify-between px-5 py-3 border-b border-gray-100">
            <p className="text-sm font-medium text-gray-700">상품별 현재 재고</p>
            <div className="flex items-center gap-3">
              <SearchBox
                placeholder="상품명, 색상, 사이즈 검색"
                onSearch={setStockSearch}
                onQueryChange={handleStockQueryChange}
                suggestions={stockSuggestions}
                inputWidth="w-56"
              />
              <button onClick={() => tenantId && fetchStock(tenantId)}
                className="px-3 py-1.5 text-sm border border-gray-300 rounded-lg hover:bg-gray-50">새로고침</button>
            </div>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <TableHead>
                <Th className="w-10 text-gray-500">No</Th>
                <Th className="w-24 text-gray-500">SKU</Th>
                <Th className="text-left">상품명</Th>
                <Th>색상</Th>
                <Th>사이즈</Th>
                <Th>상태</Th>
                <Th className="text-right">현재 재고</Th>
                <Th className="text-right">미송 잔여</Th>
                <Th className="text-right">보류 잔여</Th>
                <Th className="text-right">출고 가능</Th>
              </TableHead>
              <tbody>
                {loadingStock ? (
                  <LoadingRow colSpan={10} />
                ) : filteredStock.length === 0 ? (
                  <EmptyRow colSpan={10} message="재고 데이터가 없습니다." />
                ) : filteredStock.map((r, i) => {
                  const available = r.quantity - r.backorder_qty - r.hold_qty;
                  return (
                    <tr key={r.variant_id} className="border-b border-gray-100 hover:bg-gray-50">
                      <td className="px-3 py-2.5 text-center text-gray-400 text-xs">{i + 1}</td>
                      <td className="px-3 py-2.5 text-center text-gray-400 font-mono text-xs">{formatSku(r.product_no, r.sku)}</td>
                      <td className="px-4 py-2.5 font-medium text-gray-800">{r.product_name}</td>
                      <td className="px-4 py-2.5 text-center text-gray-600">{r.color}</td>
                      <td className="px-4 py-2.5 text-center text-gray-600">{r.size}</td>
                      <td className="px-4 py-2.5 text-center">
                        <div className="inline-flex rounded border border-gray-200 overflow-hidden text-xs">
                          {([
                            ["active",  "진행", "bg-green-600 text-white",  "text-green-700 hover:bg-green-50"],
                            ["sale",    "세일", "bg-rose-500 text-white",   "text-rose-600 hover:bg-rose-50"],
                            ["inactive","품절", "bg-gray-500 text-white",   "text-gray-500 hover:bg-gray-100"],
                          ] as const).map(([key, label, onCls, offCls]) => (
                            <button
                              key={key}
                              onClick={() => r.status !== key && setVariantStatus(r.variant_id, key)}
                              className={`px-2 py-0.5 transition-colors ${r.status === key ? onCls : offCls}`}
                              title={label}
                            >{label}</button>
                          ))}
                        </div>
                      </td>
                      <td className={`px-4 py-2.5 text-right font-bold ${
                        r.quantity === 0 ? "text-gray-300" : r.quantity < 5 ? "text-red-500" : "text-gray-900"
                      }`}>{r.quantity.toLocaleString()}</td>
                      <td className={`px-4 py-2.5 text-right ${r.backorder_qty > 0 ? "text-orange-600 font-medium" : "text-gray-300"}`}>
                        {r.backorder_qty > 0 ? r.backorder_qty.toLocaleString() : "—"}
                      </td>
                      <td className={`px-4 py-2.5 text-right ${r.hold_qty > 0 ? "text-yellow-600 font-medium" : "text-gray-300"}`}>
                        {r.hold_qty > 0 ? r.hold_qty.toLocaleString() : "—"}
                      </td>
                      <td className={`px-4 py-2.5 text-right ${available < 0 ? "text-red-500 font-bold" : "text-gray-700"}`}>
                        {available.toLocaleString()}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
