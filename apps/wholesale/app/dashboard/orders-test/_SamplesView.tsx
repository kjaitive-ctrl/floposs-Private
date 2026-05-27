"use client";

import { useEffect, useState, useCallback } from "react";
import { createPortal } from "react-dom";
import { supabase } from "@/lib/supabase";
import { krw, formatDate } from "@/lib/format";
import { ensureBizOpen } from "@/lib/bizSession";
import { DataTable, TableHead, Th, Badge, EmptyRow, LoadingRow } from "../_components/DataTable";

type SampleStatus = "pending" | "returned" | "converted";
type SampleSubTab = "pending" | "returned" | "converted" | "all";

type SampleRow = {
  id: string;
  order_id: string;
  quantity: number;
  unit_price: number;
  is_sample: boolean;
  sample_status: SampleStatus | null;
  sample_due_date: string | null;
  sample_memo: string | null;
  created_at: string;
  product_variants: {
    color: string | null;
    size: string | null;
    products: { name: string } | null;
  } | null;
  orders: {
    order_number: string;
    customer_id: string;
    customer_name: string | null;
    customers: { company_name: string } | null;
  } | null;
};

function dueDayDiff(due: string | null): number | null {
  if (!due) return null;
  const todayStr = new Date().toISOString().slice(0, 10);
  const today = new Date(todayStr);
  const dueDate = new Date(due);
  return Math.round((dueDate.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
}

type Props = {
  tenantId: string;
  /** 지정되면 [처리!] 버튼을 createPortal 로 그 element 안에 렌더 (외부 하단 띠로 분리). */
  actionBarTarget?: HTMLElement | null;
};

export default function SamplesView({ tenantId, actionBarTarget }: Props) {
  const [rows, setRows] = useState<SampleRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [subTab, setSubTab] = useState<SampleSubTab>("pending");
  const [customerSearch, setCustomerSearch] = useState("");
  const [memoEditId, setMemoEditId] = useState<string | null>(null);
  const [memoDraft, setMemoDraft] = useState("");
  const [savingMemo, setSavingMemo] = useState(false);
  // 상품기준 탭과 동일한 "선택 후 일괄 처리" 패턴.
  // 한 행은 반납/샘결 둘 중 하나만 토글되도록 배타 적용.
  const [returnIds, setReturnIds] = useState<Set<string>>(new Set());
  const [convertIds, setConvertIds] = useState<Set<string>>(new Set());
  const [processing, setProcessing] = useState(false);

  const fetchSamples = useCallback(async (tid: string, currentTab: SampleSubTab) => {
    setLoading(true);
    let q = supabase
      .from("order_items")
      .select(`
        id, order_id, quantity, unit_price, is_sample, sample_status, sample_due_date, sample_memo, created_at,
        product_variants(color, size, products(name)),
        orders!inner(order_number, customer_id, customer_name, tenant_id, customers(company_name))
      `)
      .eq("is_sample", true)
      .eq("orders.tenant_id", tid)
      .order("sample_due_date", { ascending: true });

    if (currentTab !== "all") q = q.eq("sample_status", currentTab);

    const { data } = await q;
    setRows((data ?? []) as unknown as SampleRow[]);
    setLoading(false);
  }, []);

  useEffect(() => {
    fetchSamples(tenantId, subTab);
    setReturnIds(new Set());
    setConvertIds(new Set());
  }, [tenantId, subTab, fetchSamples]);

  const filteredRows = customerSearch.trim()
    ? rows.filter(r => {
        const name = r.orders?.customers?.company_name ?? r.orders?.customer_name ?? "";
        return name.toLowerCase().includes(customerSearch.trim().toLowerCase());
      })
    : rows;

  function toggleReturn(id: string) {
    setReturnIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else {
        next.add(id);
        setConvertIds(p => { const c = new Set(p); c.delete(id); return c; });
      }
      return next;
    });
  }

  function toggleConvert(id: string) {
    setConvertIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else {
        next.add(id);
        setReturnIds(p => { const r = new Set(p); r.delete(id); return r; });
      }
      return next;
    });
  }

  async function handleProcess() {
    if (processing) return;
    const total = returnIds.size + convertIds.size;
    if (total === 0) return;
    if (!ensureBizOpen()) return;

    setProcessing(true);
    // 반납은 거래처/주문 묶음 무관 — 항목별 처리 그대로
    for (const id of returnIds) {
      const { data, error } = await supabase.rpc("process_sample_return", {
        p_order_item_id: id, p_tenant_id: tenantId,
      });
      if (error) { alert("반납 오류: " + error.message); setProcessing(false); return; }
      const result = data as { success: boolean; error?: string };
      if (!result?.success) { alert("반납 실패: " + (result?.error ?? "알 수 없음")); setProcessing(false); return; }
    }
    // 샘플결제: 거래처별 묶음 → 거래처당 영수증 1장 (마이그 114 batch RPC)
    if (convertIds.size > 0) {
      const idToCustomer = new Map<string, string>();
      rows.forEach(r => {
        if (convertIds.has(r.id) && r.orders?.customer_id) {
          idToCustomer.set(r.id, r.orders.customer_id);
        }
      });
      const groups = new Map<string, string[]>();
      idToCustomer.forEach((customerId, itemId) => {
        const arr = groups.get(customerId) ?? [];
        arr.push(itemId);
        groups.set(customerId, arr);
      });
      for (const [, itemIds] of groups) {
        const { data, error } = await supabase.rpc("convert_samples_bulk", {
          p_order_item_ids: itemIds, p_tenant_id: tenantId,
        });
        if (error) { alert("샘결 오류: " + error.message); setProcessing(false); return; }
        const result = data as { success: boolean; error?: string };
        if (!result?.success) { alert("샘결 실패: " + (result?.error ?? "알 수 없음")); setProcessing(false); return; }
      }
    }
    setReturnIds(new Set());
    setConvertIds(new Set());
    setProcessing(false);
    fetchSamples(tenantId, subTab);
  }

  function startMemoEdit(row: SampleRow) {
    setMemoEditId(row.id);
    setMemoDraft(row.sample_memo ?? "");
  }

  async function saveMemoEdit() {
    if (!memoEditId) return;
    setSavingMemo(true);
    const { error } = await supabase
      .from("order_items")
      .update({ sample_memo: memoDraft || null })
      .eq("id", memoEditId);
    setSavingMemo(false);
    if (error) { alert("메모 저장 오류: " + error.message); return; }
    setRows(prev => prev.map(r => r.id === memoEditId ? { ...r, sample_memo: memoDraft || null } : r));
    setMemoEditId(null);
    setMemoDraft("");
  }

  function cancelMemoEdit() {
    setMemoEditId(null);
    setMemoDraft("");
  }

  const subTabs: { key: SampleSubTab; label: string }[] = [
    { key: "pending",   label: "보유 중" },
    { key: "returned",  label: "반납 완료" },
    { key: "converted", label: "샘결 완료" },
    { key: "all",       label: "전체" },
  ];

  return (
    <div>
      <div className="flex items-center gap-3 mb-3">
        <div className="flex rounded-lg border border-gray-300 overflow-hidden text-xs">
          {subTabs.map(t => (
            <button key={t.key}
              onClick={() => setSubTab(t.key)}
              className={`px-3 py-1.5 transition-colors ${
                subTab === t.key ? "bg-primary text-white" : "text-gray-600 hover:bg-gray-50"
              }`}>
              {t.label}
            </button>
          ))}
        </div>
        <input type="text" value={customerSearch}
          onChange={e => setCustomerSearch(e.target.value)}
          placeholder="거래처 검색"
          className="px-3 py-1.5 border border-gray-300 rounded-lg text-xs focus:outline-none focus:ring-2 focus:ring-primary-ring w-48" />
        <span className="text-xs text-gray-400 ml-auto">{filteredRows.length}건</span>
      </div>

      <DataTable maxHeight="100%">
        <TableHead>
          <Th>거래처</Th>
          <Th>주문번호</Th>
          <Th>상품</Th>
          <Th className="text-center">수량</Th>
          <Th className="text-right">단가</Th>
          <Th className="text-right">금액</Th>
          <Th className="text-center">출고일</Th>
          <Th className="text-center">반납기한</Th>
          <Th>메모</Th>
          <Th className="text-center">상태</Th>
          <Th className="text-center">처리</Th>
        </TableHead>
        <tbody>
          {loading ? (
            <LoadingRow colSpan={11} />
          ) : filteredRows.length === 0 ? (
            <EmptyRow colSpan={11} message="해당 상태의 샘플이 없습니다." />
          ) : filteredRows.map(row => {
            const product = row.product_variants?.products?.name ?? "—";
            const color   = row.product_variants?.color ?? "";
            const size    = row.product_variants?.size ?? "";
            const customer = row.orders?.customers?.company_name ?? row.orders?.customer_name ?? "—";
            const orderNumber = row.orders?.order_number ?? "—";
            const amount = row.quantity * row.unit_price;
            const diff = dueDayDiff(row.sample_due_date);
            const isPending = row.sample_status === "pending";
            const isReturning = returnIds.has(row.id);
            const isConverting = convertIds.has(row.id);
            const isEditing = memoEditId === row.id;

            const dueLabel = !row.sample_due_date
              ? "—"
              : diff === null
                ? formatDate(row.sample_due_date)
                : diff < 0
                  ? `${formatDate(row.sample_due_date)} (${Math.abs(diff)}일 초과)`
                  : diff === 0
                    ? `${formatDate(row.sample_due_date)} (오늘)`
                    : `${formatDate(row.sample_due_date)} (D-${diff})`;

            const dueColor = !isPending
              ? "text-gray-400"
              : diff !== null && diff < 0
                ? "text-rose-600 font-semibold"
                : diff !== null && diff <= 2
                  ? "text-amber-600 font-medium"
                  : "text-gray-700";

            const rowBg = isReturning
              ? "bg-gray-100/70 hover:bg-gray-100"
              : isConverting
                ? "bg-primary-soft/40 hover:bg-primary-soft/60"
                : "hover:bg-gray-50";
            return (
              <tr key={row.id} className={`border-b border-gray-100 transition-colors ${rowBg}`}>
                <td className="px-2 py-1.5 text-xs font-medium text-gray-800 max-w-[140px] truncate" title={customer}>{customer}</td>
                <td className="px-2 py-1.5 text-xs text-gray-500 whitespace-nowrap">{orderNumber}</td>
                <td className="px-2 py-1.5 text-xs font-medium text-gray-800 max-w-[200px] truncate">
                  {product}
                  <span className="ml-1 text-gray-400">{color} {size}</span>
                </td>
                <td className="px-2 py-1.5 text-center text-xs font-medium text-gray-900">{row.quantity}</td>
                <td className="px-2 py-1.5 text-right text-xs text-gray-700">{krw(row.unit_price)}</td>
                <td className="px-2 py-1.5 text-right text-xs font-medium text-gray-900">{krw(amount)}</td>
                <td className="px-2 py-1.5 text-center text-xs text-gray-500 whitespace-nowrap">{formatDate(row.created_at)}</td>
                <td className={`px-2 py-1.5 text-center text-xs whitespace-nowrap ${dueColor}`}>{dueLabel}</td>
                <td className="px-2 py-1.5 text-xs">
                  {isEditing ? (
                    <div className="flex gap-1 items-center">
                      <input type="text" value={memoDraft}
                        onChange={e => setMemoDraft(e.target.value)}
                        onKeyDown={e => { if (e.key === "Enter") saveMemoEdit(); if (e.key === "Escape") cancelMemoEdit(); }}
                        autoFocus
                        className="flex-1 px-1.5 py-0.5 border border-primary-ring rounded text-xs focus:outline-none focus:ring-1 focus:ring-primary-ring min-w-[120px]" />
                      <button onClick={saveMemoEdit} disabled={savingMemo}
                        className="px-1.5 py-0.5 text-xs text-primary hover:bg-primary-soft rounded">✓</button>
                      <button onClick={cancelMemoEdit} disabled={savingMemo}
                        className="px-1.5 py-0.5 text-xs text-gray-400 hover:bg-gray-50 rounded">×</button>
                    </div>
                  ) : (
                    <button onClick={() => startMemoEdit(row)}
                      className="text-left text-gray-500 hover:text-primary hover:bg-primary-soft px-1.5 py-0.5 rounded w-full max-w-[160px] truncate"
                      title={row.sample_memo ?? "메모 추가"}>
                      {row.sample_memo ?? <span className="text-gray-300">+ 메모</span>}
                    </button>
                  )}
                </td>
                <td className="px-2 py-1.5 text-center">
                  {row.sample_status === "pending"   && <Badge color="yellow">보유 중</Badge>}
                  {row.sample_status === "returned"  && <Badge color="gray">반납 완료</Badge>}
                  {row.sample_status === "converted" && <Badge color="blue">샘결 완료</Badge>}
                </td>
                <td className="px-2 py-1.5 text-center">
                  {isPending ? (
                    <div className="flex gap-1 justify-center flex-wrap">
                      <button onClick={() => toggleReturn(row.id)} disabled={processing}
                        className={`px-2 py-0.5 text-xs font-medium rounded border transition-colors disabled:opacity-40 ${
                          isReturning
                            ? "bg-gray-600 text-white border-gray-600"
                            : "bg-white text-gray-600 border-gray-300 hover:bg-gray-50"
                        }`}>
                        반납
                      </button>
                      <button onClick={() => toggleConvert(row.id)} disabled={processing}
                        className={`px-2 py-0.5 text-xs font-medium rounded border transition-colors disabled:opacity-40 ${
                          isConverting
                            ? "bg-primary text-white border-primary"
                            : "bg-primary-soft text-primary border-primary-border hover:bg-primary-soft-hover"
                        }`}>
                        샘결
                      </button>
                    </div>
                  ) : (
                    <span className="text-gray-300 text-xs">—</span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </DataTable>

      {/* 일괄 처리 — actionBarTarget 지정 시 portal, 아니면 자체 표시 */}
      {(() => {
        const total = returnIds.size + convertIds.size;
        const button = (
          <button
            onClick={handleProcess}
            disabled={total === 0 || processing}
            className={`px-10 py-3 text-lg font-bold rounded-xl shadow-md transition-colors ${
              total > 0 && !processing ? "bg-primary text-white hover:bg-primary-hover" : "bg-gray-100 text-gray-300 cursor-not-allowed"
            }`}
          >
            {processing ? "처리 중..." : total > 0 ? `처리! (${total}건)` : "처리!"}
          </button>
        );
        if (actionBarTarget) return createPortal(button, actionBarTarget);
        return (
          <div className="flex justify-end items-center pt-3 pb-1">
            {button}
          </div>
        );
      })()}
    </div>
  );
}
