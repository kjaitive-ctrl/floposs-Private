"use client";

import { useState, useEffect, useCallback } from "react";
import { useTenantId } from "@/lib/useTenant";
import { supabase } from "@/lib/supabase";
import { krw, formatDate, today, DATE_PRESETS, getPresetRange, METHOD_LABELS, displayOutstanding } from "@/lib/format";
import { insertTransaction } from "@/lib/transactions";
import { ensureBizOpen } from "@/lib/bizSession";
import type { Customer as FullCustomer } from "@/lib/types";
import { DataTable, TableHead, Th, EmptyRow, LoadingRow, PageHeader } from "../_components/DataTable";
import CustomerPaymentForm from "../_components/CustomerPaymentForm";

type Customer = Pick<FullCustomer, "id" | "company_name" | "outstanding_balance" | "outstanding_vat" | "default_payment_method" | "include_vat">;

type TxRow = {
  id: string;
  type: string;
  source: string | null;
  amount: number;
  vat_amount: number | null;
  vat_type: "supply" | "vat";   // 161
  method: string | null;
  transaction_date: string;
  created_at: string;
  description: string | null;
  outstanding_snapshot: number | null;
  order_id: string | null;
  customer_id: string | null;
  customers: { company_name: string; default_payment_method: string | null } | null;
};

type PaymentForm = {
  mode: "customer" | "manual";
  // customer mode — 입력값/부가세 토글은 CustomerPaymentForm 컴포넌트가 자체 관리
  customerId: string;
  customerName: string;
  // manual mode (기타 입출금) — method=cash 고정, date=today 고정
  income: string;
  expense: string;
  description: string;
  // common
  processing: boolean;
};

function txLabel(type: string, source: string | null): { label: string; color: string } {
  if (source === "shipment")       return { label: "판매",     color: "text-gray-700" };
  if (source === "return")         return { label: "반품",     color: "text-rose-500" };
  if (source === "cancel" || source === "cancellation") return { label: "취소", color: "text-gray-400" };
  if (source === "payment")        return { label: "입금",     color: "text-emerald-600" };
  if (source === "refund")         return { label: "환불",     color: "text-rose-500" };
  if (source === "vat_collection") return { label: "부가세입금", color: "text-orange-600" };
  if (source === "credit_apply")   return { label: "매입충당",   color: "text-primary-ring" };
  if (source === "purchase")       return { label: "매입충당",   color: "text-primary-ring" };  // 084 apply_purchase_credit 호환
  if (source === "manual") {
    if (type === "income")       return { label: "수동입금", color: "text-emerald-600" };
    if (type === "expense")      return { label: "수동출금", color: "text-rose-500" };
    return                              { label: "수동",    color: "text-gray-500" };
  }
  if (type === "income")         return { label: "입금",    color: "text-emerald-600" };
  if (type === "expense")        return { label: "출금",    color: "text-rose-500" };
  if (type === "receivable")     return { label: "외상",    color: "text-amber-600" };
  return                                { label: source ?? type, color: "text-gray-500" };
}

function methodLabel(method: string | null): string {
  if (method === "cash")           return "현금";
  if (method === "transfer")       return "통장";
  if (method === "credit")         return "청구";
  if (method === "card")           return "카드";
  if (method === "credit_balance") return "매입";
  return method ?? "";
}

function methodColor(method: string | null): string {
  if (method === "cash")           return "text-green-600";
  if (method === "transfer")       return "text-primary";
  if (method === "credit")         return "text-purple-600";
  if (method === "credit_balance") return "text-primary-ring";
  return "text-gray-500";
}

export default function TransactionsPage() {
  const tenantId = useTenantId();

  const [customers, setCustomers] = useState<Customer[]>([]);
  const [loadingCustomers, setLoadingCustomers] = useState(false);
  const [selectedCustomer, setSelectedCustomer] = useState<Customer | null>(null);
  const [isAllSelected, setIsAllSelected] = useState(false);

  const [txRows, setTxRows] = useState<TxRow[]>([]);
  const [loadingTx, setLoadingTx] = useState(false);

  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [activePreset, setActivePreset] = useState("");

  const [paymentForm, setPaymentForm] = useState<PaymentForm | null>(null);

  const fetchCustomers = useCallback(async (tid: string) => {
    setLoadingCustomers(true);
    const { data } = await supabase
      .from("customers")
      .select("id, company_name, outstanding_balance, outstanding_vat, default_payment_method, include_vat")
      .eq("tenant_id", tid)
      .eq("is_active", true)
      .order("outstanding_balance", { ascending: false });
    setCustomers((data ?? []) as Customer[]);
    setLoadingCustomers(false);
  }, []);

  const fetchTransactions = useCallback(async (tid: string, customerId: string | null, from: string, to: string) => {
    setLoadingTx(true);
    let q = supabase
      .from("transactions")
      .select("id, type, source, amount, vat_amount, vat_type, method, transaction_date, created_at, description, outstanding_snapshot, order_id, customer_id, customers(company_name, default_payment_method)")
      .eq("tenant_id", tid)
      .order("transaction_date", { ascending: false })
      .order("created_at", { ascending: false });

    if (customerId) q = q.eq("customer_id", customerId);
    if (from) q = q.gte("transaction_date", from);
    if (to)   q = q.lte("transaction_date", to);

    const { data } = await q;
    // 정책 (2026-05-12 사장 최종 결정 — 옵션 B):
    //   부가세 컬럼 = 입금 cash flow 만. 매출/반품 vat 외상은 DB 박제용 (영업정산/부가세 페이지가 전담).
    //   판매와 반품 모두 판매/취소 컬럼에만 ± 표시 (일관). 부가세 컬럼은 — 표시.
    const filtered = (data ?? []).filter((tx: { source: string | null; vat_type: string }) =>
      !(tx.vat_type === "vat" && (tx.source === "shipment" || tx.source === "return"))
    ) as unknown as TxRow[];

    // PAIRED: 실제 cash flow 만 supply + vat 페어링. shipment/return 은 supply 행만 표시.
    const PAIRED = new Set(["payment", "refund", "credit_apply"]);
    const groupKey = (tx: TxRow) =>
      `${tx.source}|${tx.type}|${tx.method}|${tx.customer_id ?? ""}|${tx.order_id ?? ""}|${tx.transaction_date}`;
    const groups = new Map<string, TxRow[]>();
    const ungrouped: TxRow[] = [];
    for (const tx of filtered) {
      if (PAIRED.has(tx.source ?? "")) {
        const k = groupKey(tx);
        if (!groups.has(k)) groups.set(k, []);
        groups.get(k)!.push(tx);
      } else {
        ungrouped.push(tx);
      }
    }
    const pairedConsumed = new Set<string>();
    const mergedFromPairs: TxRow[] = [];
    for (const rows of groups.values()) {
      const supplies = rows.filter(r => r.vat_type === "supply").sort((a, b) => a.created_at.localeCompare(b.created_at));
      const vats     = rows.filter(r => r.vat_type === "vat")   .sort((a, b) => a.created_at.localeCompare(b.created_at));
      for (let i = 0; i < supplies.length; i++) {
        const sup = supplies[i];
        const v   = vats[i];
        if (v) {
          mergedFromPairs.push({ ...sup, vat_amount: Math.abs(v.amount) });
          pairedConsumed.add(sup.id); pairedConsumed.add(v.id);
        } else {
          mergedFromPairs.push(sup);
          pairedConsumed.add(sup.id);
        }
      }
      // unpaired vat rows (vat 행이 supply 행보다 많을 때)
      for (let i = supplies.length; i < vats.length; i++) {
        mergedFromPairs.push(vats[i]);
        pairedConsumed.add(vats[i].id);
      }
    }
    const merged = [...mergedFromPairs, ...ungrouped]
      .sort((a, b) => b.transaction_date.localeCompare(a.transaction_date) || b.created_at.localeCompare(a.created_at));
    setTxRows(merged);
    setLoadingTx(false);
  }, []);

  useEffect(() => {
    if (tenantId) fetchCustomers(tenantId);
  }, [tenantId, fetchCustomers]);

  useEffect(() => {
    if (tenantId && (isAllSelected || selectedCustomer)) {
      fetchTransactions(tenantId, selectedCustomer?.id ?? null, dateFrom, dateTo);
    }
  }, [tenantId, isAllSelected, selectedCustomer, dateFrom, dateTo, fetchTransactions]);

  function applyPreset(key: string) {
    const [from, to] = getPresetRange(key);
    setDateFrom(from); setDateTo(to); setActivePreset(key);
  }

  function clearDates() {
    setDateFrom(""); setDateTo(""); setActivePreset("");
  }

  function selectAll() {
    setSelectedCustomer(null);
    setIsAllSelected(true);
    setPaymentForm(null);
  }

  function selectCustomer(c: Customer) {
    setSelectedCustomer(c);
    setIsAllSelected(false);
    setPaymentForm(null);
  }

  async function handlePayment() {
    if (!tenantId || !paymentForm) return;
    if (!ensureBizOpen()) return;

    if (paymentForm.mode === "manual") {
      const incomeAmt  = Math.round(parseFloat(paymentForm.income.replace(/,/g, ""))  || 0);
      const expenseAmt = Math.round(parseFloat(paymentForm.expense.replace(/,/g, "")) || 0);
      if (!incomeAmt && !expenseAmt) return;
      if (incomeAmt && expenseAmt) { alert("입금액과 출금액 중 하나만 입력하세요."); return; }
      setPaymentForm(prev => prev ? { ...prev, processing: true } : null);

      const txType: "income" | "expense" = incomeAmt ? "income" : "expense";
      const txAmount = incomeAmt || expenseAmt;

      const { error } = await insertTransaction({
        tenant_id: tenantId,
        customer_id: null,
        type: txType,
        amount: txAmount,
        method: "cash",
        source: "manual",
        transaction_date: today(),
        description: paymentForm.description || null,
      });

      if (error) {
        alert("등록 오류: " + error.message);
        setPaymentForm(prev => prev ? { ...prev, processing: false } : null);
        return;
      }
      setPaymentForm(null);
      if (isAllSelected) fetchTransactions(tenantId, null, dateFrom, dateTo);
      return;
    }

    // customer mode 는 CustomerPaymentForm 의 onSubmit 콜백에서 처리.
    // (이 함수는 manual mode 만 사용)
  }

  async function handleCustomerPayment(
    customerId: string,
    data: { amount: number; vatOn: boolean; vatAmount: number },
  ) {
    if (!tenantId) return;
    setPaymentForm(prev => prev ? { ...prev, processing: true } : null);

    const pm = customers.find(c => c.id === customerId)?.default_payment_method ?? "transfer";
    const isRefund = data.amount < 0;
    const vatMode = data.vatOn ? "included" : "none";

    const { error } = isRefund
      ? await supabase.rpc("process_refund", {
          p_tenant_id:   tenantId,
          p_customer_id: customerId,
          p_amount:      Math.abs(data.amount),
          p_method:      pm,
          p_vat_mode:    vatMode,
          p_vat_amount:  data.vatAmount,
        })
      : await supabase.rpc("process_payment", {
          p_tenant_id:   tenantId,
          p_customer_id: customerId,
          p_amount:      data.amount,
          p_method:      pm,
          p_source:      "payment",
          p_order_id:    null,
          p_vat_mode:    vatMode,
          p_vat_amount:  data.vatAmount,
        });

    if (error) {
      alert((isRefund ? "환불 오류: " : "입금 오류: ") + error.message);
      setPaymentForm(prev => prev ? { ...prev, processing: false } : null);
      return;
    }
    setPaymentForm(null);
    await fetchCustomers(tenantId);
    if (selectedCustomer) {
      const updated = customers.find(c => c.id === selectedCustomer.id);
      if (updated) setSelectedCustomer(updated);
      fetchTransactions(tenantId, selectedCustomer.id, dateFrom, dateTo);
    }
  }

  // 잔액 합계 (161 vat ledger 분리)
  // - vat_type='supply' 행만 saleNet/cash/transfer/credit/manualNet 에 합산
  // - vat_type='vat' 행은 vat 합산에만 사용
  // - credit_apply / purchase 는 현금 흐름 X
  const totals = txRows.reduce(
    (acc, tx) => {
      if (tx.source === "credit_apply" || tx.source === "purchase") return acc;
      const isReturnLike = tx.source === "return" || tx.source === "cancel" || tx.source === "cancellation";

      // vat 행 (standalone, e.g. vat_collection): 부가세 합계만
      if (tx.vat_type === "vat") {
        const sign = tx.type === "expense" || isReturnLike ? -1 : 1;
        acc.vat += sign * tx.amount;
        return acc;
      }

      // supply 행: 결제수단별 합산 + (merged) vat_amount 가 있으면 부가세 합계에도 추가
      const sign = tx.type === "expense" ? -1 : 1;
      const vatPart = tx.vat_amount ?? 0;
      if (vatPart > 0 && (tx.type === "income" || tx.type === "expense")) {
        // 옵션 B 정책: payment/refund/credit_apply 만 (return 은 supply 행 표시. vat hidden).
        acc.vat += sign * vatPart;
      }

      if (tx.type === "receivable" || isReturnLike) {
        const isMinus = isReturnLike;
        acc.saleNet += isMinus ? -tx.amount : tx.amount;
      } else if (tx.type === "income" || tx.type === "expense") {
        if (tx.customer_id === null) acc.manualNet += sign * tx.amount;
        else if (tx.method === "cash")     acc.cash     += sign * tx.amount;
        else if (tx.method === "transfer") acc.transfer += sign * tx.amount;
        else                                acc.credit   += sign * tx.amount;
      }
      return acc;
    },
    { saleNet: 0, cash: 0, transfer: 0, credit: 0, manualNet: 0, vat: 0 }
  );

  return (
    <div className="flex flex-col h-[calc(100vh-4rem)] overflow-hidden">
      <PageHeader title="입출금 관리" />

      <div className="flex gap-4 flex-1 min-h-0">

        {/* 거래처 목록 + 입금 폼 */}
        <div className="flex flex-col w-2/5 min-h-0">
          <DataTable maxHeight="none" className="flex-1 overflow-auto">
            <TableHead>
              <Th>거래처</Th>
              <Th>결제</Th>
              <Th>미수금</Th>
              <Th className="px-2">입출금</Th>
            </TableHead>
            <tbody>
              {loadingCustomers ? (
                <LoadingRow colSpan={4} />
              ) : (
                <>
                  <tr
                    onClick={() => {
                      selectAll();
                      setPaymentForm(paymentForm?.mode === "manual" ? null : {
                        mode: "manual",
                        customerId: "",
                        customerName: "",
                        income: "",
                        expense: "",
                        description: "",
                        processing: false,
                      });
                    }}
                    className={`border-b border-gray-100 cursor-pointer transition-colors ${
                      isAllSelected ? "bg-primary-soft" : "hover:bg-gray-50"
                    }`}
                  >
                    <td colSpan={3} className="px-3 py-2 text-sm font-semibold text-gray-700">전체</td>
                    <td className="px-2 py-2 text-center">
                      <span
                        className={`px-2 py-0.5 text-xs font-medium rounded border transition-colors pointer-events-none ${
                          paymentForm?.mode === "manual"
                            ? "bg-amber-500 text-white border-amber-500"
                            : "bg-white text-amber-600 border-amber-300"
                        }`}
                      >돈통</span>
                    </td>
                  </tr>
                  {customers.length === 0 ? null : customers.map(c => {
                const bal = displayOutstanding(c);
                const isSelected = selectedCustomer?.id === c.id;
                const isFormOpen = paymentForm?.mode === "customer" && paymentForm.customerId === c.id;
                return (
                  <tr
                    key={c.id}
                    onClick={() => {
                      selectCustomer(c);
                      setPaymentForm(isFormOpen ? null : {
                        mode: "customer",
                        customerId: c.id,
                        customerName: c.company_name,
                        income: "",
                        expense: "",
                        description: "",
                        processing: false,
                      });
                    }}
                    className={`border-b border-gray-100 cursor-pointer transition-colors ${
                      isSelected ? "bg-primary-soft" : "hover:bg-gray-50"
                    }`}
                  >
                    <td className="px-3 py-2 text-sm font-medium text-gray-800">{c.company_name}</td>
                    <td className="px-2 py-2 text-center">
                      <span className={`text-xs font-medium ${methodColor(c.default_payment_method)}`}>
                        {methodLabel(c.default_payment_method)}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-right text-sm font-semibold">
                      {bal === 0
                        ? <span className="text-gray-300">—</span>
                        : <span className={bal > 0 ? "text-red-500" : "text-primary-ring"}>{krw(Math.abs(bal))}</span>
                      }
                    </td>
                    <td className="px-2 py-2 text-center">
                      <span
                        className={`px-2 py-0.5 text-xs font-medium rounded border transition-colors pointer-events-none ${
                          isFormOpen
                            ? "bg-credit text-white border-credit"
                            : "bg-white text-credit border-credit-border"
                        }`}
                      >입금처리</span>
                    </td>
                  </tr>
                );
              })}
                </>
              )}
            </tbody>
          </DataTable>

          {/* 입출금 폼 */}
          {paymentForm && paymentForm.mode === "manual" && (() => {
            const isExpense = !!paymentForm.expense && !paymentForm.income;
            return (
              <div className="shrink-0 mt-3 border border-amber-200 rounded-xl overflow-hidden">
                <div className="px-4 py-2 bg-amber-50 border-b border-amber-200 flex items-center justify-between">
                  <span className="text-xs font-semibold text-amber-700 tracking-wide">기타 입출금 (돈통)</span>
                  <span className="text-xs text-amber-700/70">현금 · {formatDate(today())}</span>
                </div>
                <div className="px-4 py-4 bg-white flex flex-col gap-3">
                  <div className="flex items-center gap-3">
                    <label className="w-20 text-sm text-emerald-600 shrink-0">입금액</label>
                    <input type="text" value={paymentForm.income}
                      onChange={e => {
                        const raw = e.target.value.replace(/[^0-9]/g, "");
                        const num = parseInt(raw, 10);
                        const fmt = isNaN(num) ? "" : num.toLocaleString();
                        setPaymentForm(prev => prev?.mode === "manual" ? { ...prev, income: fmt } : prev);
                      }}
                      placeholder="0"
                      disabled={!!paymentForm.expense}
                      className="flex-1 px-3 py-2 border border-gray-300 rounded-lg text-sm text-right focus:outline-none focus:ring-2 focus:ring-emerald-400 placeholder:text-gray-300 disabled:bg-gray-50 disabled:text-gray-400" />
                  </div>
                  <div className="flex items-center gap-3">
                    <label className="w-20 text-sm text-rose-500 shrink-0">출금액</label>
                    <input type="text" value={paymentForm.expense}
                      onChange={e => {
                        const raw = e.target.value.replace(/[^0-9]/g, "");
                        const num = parseInt(raw, 10);
                        const fmt = isNaN(num) ? "" : num.toLocaleString();
                        setPaymentForm(prev => prev?.mode === "manual" ? { ...prev, expense: fmt } : prev);
                      }}
                      placeholder="0"
                      disabled={!!paymentForm.income}
                      className="flex-1 px-3 py-2 border border-gray-300 rounded-lg text-sm text-right focus:outline-none focus:ring-2 focus:ring-rose-400 placeholder:text-gray-300 disabled:bg-gray-50 disabled:text-gray-400" />
                  </div>
                  <div className="flex items-center gap-3">
                    <label className="w-20 text-sm text-gray-500 shrink-0">메모</label>
                    <input type="text" value={paymentForm.description}
                      onChange={e => setPaymentForm(prev => prev?.mode === "manual" ? { ...prev, description: e.target.value } : prev)}
                      placeholder="예: 식대 22,000 / 운송비 / 사무용품 등"
                      className="flex-1 px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-amber-400 placeholder:text-gray-300" />
                  </div>
                  <div className="flex justify-end gap-2 pt-1">
                    <button onClick={() => setPaymentForm(null)}
                      className="px-5 py-2 text-sm text-gray-600 border border-gray-300 rounded-lg hover:bg-gray-50">취소</button>
                    <button onClick={handlePayment}
                      disabled={paymentForm.processing || (!paymentForm.income && !paymentForm.expense)}
                      className={`px-5 py-2 text-sm font-semibold text-white rounded-lg disabled:opacity-40 disabled:cursor-not-allowed ${
                        isExpense ? "bg-rose-500 hover:bg-rose-600" : "bg-emerald-600 hover:bg-emerald-700"
                      }`}>
                      {paymentForm.processing ? "처리 중..." : isExpense ? "출금 등록" : "입금 등록"}
                    </button>
                  </div>
                </div>
              </div>
            );
          })()}

          {/* 거래처 입금 폼 — 공통 컴포넌트 */}
          {paymentForm && paymentForm.mode === "customer" && (() => {
            const c = customers.find(c => c.id === paymentForm.customerId);
            const customerVat = c?.include_vat ?? false;
            const pm = c?.default_payment_method ?? "transfer";
            // 입금에 부가세 포함 여부 = 과세사업자(include_vat) AND 결제수단=청구.
            // 현금/통장은 입금 시 부가세 미포함 — 월말 부가세 정산에서 별도 입금받음.
            const vatInPayment = customerVat && pm === "credit";
            const pmLabel = METHOD_LABELS[pm] ?? pm;
            const pmColor = pm === "cash" ? "text-green-700" : pm === "transfer" ? "text-primary-hover" : "text-purple-700";
            return (
              <CustomerPaymentForm
                customerName={paymentForm.customerName}
                customerVatDefault={vatInPayment}
                paymentMethodLabel={pmLabel}
                paymentMethodColorClass={pmColor}
                processing={paymentForm.processing}
                onCancel={() => setPaymentForm(null)}
                onSubmit={data => handleCustomerPayment(paymentForm.customerId, data)}
              />
            );
          })()}
        </div>

        {/* 거래 내역 */}
        <div className="flex flex-col w-3/5 min-h-0">
          {/* 상단 필터 + 거래처 정보 */}
          <div className="flex items-center gap-2 mb-3 shrink-0">
            {selectedCustomer ? (() => {
              const dispBal = displayOutstanding(selectedCustomer);
              return (
                <>
                  <span className="text-sm font-bold text-gray-900 mr-1">{selectedCustomer.company_name}</span>
                  <span className={`text-sm font-semibold ${dispBal > 0 ? "text-red-500" : dispBal < 0 ? "text-primary-ring" : "text-gray-400"}`}>
                    {dispBal === 0 ? "잔액 없음" : krw(Math.abs(dispBal))}
                  </span>
                </>
              );
            })() : (
              <span className="text-sm text-gray-400">거래처를 선택하세요</span>
            )}
            <div className="flex rounded-lg border border-gray-300 overflow-hidden text-xs ml-auto">
              {DATE_PRESETS.map(p => (
                <button
                  key={p.key}
                  onClick={() => activePreset === p.key ? clearDates() : applyPreset(p.key)}
                  className={`px-2.5 py-1.5 transition-colors ${activePreset === p.key ? "bg-primary text-white" : "text-gray-600 hover:bg-gray-50"}`}
                >
                  {p.label}
                </button>
              ))}
            </div>
            <input type="date" value={dateFrom}
              onChange={e => { setDateFrom(e.target.value); setActivePreset(""); }}
              className="px-2 py-1.5 border border-gray-300 rounded-lg text-xs focus:outline-none focus:ring-2 focus:ring-primary-ring" />
            <span className="text-gray-400 text-xs">~</span>
            <input type="date" value={dateTo}
              onChange={e => { setDateTo(e.target.value); setActivePreset(""); }}
              className="px-2 py-1.5 border border-gray-300 rounded-lg text-xs focus:outline-none focus:ring-2 focus:ring-primary-ring" />
            {(dateFrom || dateTo) && (
              <button onClick={clearDates} className="px-2 py-1.5 text-xs text-gray-400 hover:text-gray-600 border border-gray-300 rounded-lg">✕</button>
            )}
          </div>

          <DataTable maxHeight="none" className="flex-1 overflow-auto">
            {(() => {
              const colSpan = isAllSelected ? 10 : 9;
              const isActive = isAllSelected || !!selectedCustomer;
              return (
                <>
                  <thead className="bg-gray-50 border-b border-gray-200 sticky top-0 z-10">
                    {isActive && txRows.length > 0 && (
                      <tr className="bg-primary-soft border-b border-primary-soft-hover text-xs font-bold">
                        <td colSpan={isAllSelected ? 2 : 1} className="px-3 py-2 text-primary-hover">{txRows.length}건</td>
                        <td className="px-3 py-2 text-primary-hover text-center">합계</td>
                        <td className={`px-3 py-2 text-right ${totals.saleNet < 0 ? "text-rose-500" : "text-gray-700"}`}>
                          {totals.saleNet !== 0 ? `${totals.saleNet < 0 ? "−" : ""}${krw(Math.abs(totals.saleNet))}` : ""}
                        </td>
                        <td className={`px-3 py-2 text-right ${totals.cash < 0 ? "text-rose-500" : "text-green-600"}`}>
                          {totals.cash !== 0 ? `${totals.cash < 0 ? "−" : ""}${krw(Math.abs(totals.cash))}` : ""}
                        </td>
                        <td className={`px-3 py-2 text-right ${totals.transfer < 0 ? "text-rose-500" : "text-primary"}`}>
                          {totals.transfer !== 0 ? `${totals.transfer < 0 ? "−" : ""}${krw(Math.abs(totals.transfer))}` : ""}
                        </td>
                        <td className={`px-3 py-2 text-right ${totals.credit < 0 ? "text-rose-500" : "text-purple-600"}`}>
                          {totals.credit !== 0 ? `${totals.credit < 0 ? "−" : ""}${krw(Math.abs(totals.credit))}` : ""}
                        </td>
                        <td className={`px-3 py-2 text-right ${totals.manualNet < 0 ? "text-rose-500" : "text-emerald-600"}`}>
                          {totals.manualNet !== 0 ? `${totals.manualNet < 0 ? "−" : "+"}${krw(Math.abs(totals.manualNet))}` : ""}
                        </td>
                        <td className={`px-3 py-2 text-right ${totals.vat < 0 ? "text-rose-500" : "text-orange-600"}`}>
                          {totals.vat !== 0 ? `${totals.vat < 0 ? "−" : ""}${krw(Math.abs(totals.vat))}` : ""}
                        </td>
                        <td />
                      </tr>
                    )}
                    <tr className="text-xs">
                      <Th>날짜</Th>
                      {isAllSelected && <Th>거래처</Th>}
                      <Th>구분</Th>
                      <Th>판매/취소</Th>
                      <Th>
                        <div className="leading-tight">현금<br /><span className="font-normal text-gray-400">(공급가)</span></div>
                      </Th>
                      <Th>
                        <div className="leading-tight">통장<br /><span className="font-normal text-gray-400">(공급가)</span></div>
                      </Th>
                      <Th>
                        <div className="leading-tight">청구입금<br /><span className="font-normal text-gray-400">(공급가)</span></div>
                      </Th>
                      <Th>기타 입출금</Th>
                      <Th>부가세</Th>
                      <Th>메모</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {!isActive ? (
                      <EmptyRow colSpan={colSpan} message="거래처를 선택하면 내역이 표시됩니다." />
                    ) : loadingTx ? (
                      <LoadingRow colSpan={colSpan} />
                    ) : txRows.length === 0 ? (
                      <EmptyRow colSpan={colSpan} message="내역이 없습니다." />
                    ) : txRows.map(tx => {
                      const { label, color } = txLabel(tx.type, tx.source);
                      // 161: vat_type 별 row 분리 표시.
                      //   supply 행: 판매/결제수단 컬럼에 표시, 부가세 컬럼은 dash
                      //   vat 행: 판매/결제수단 컬럼은 dash, 부가세 컬럼에 표시
                      const isVatRow = tx.vat_type === "vat";
                      const isReturnLike = tx.source === "return" || tx.source === "cancel" || tx.source === "cancellation";
                      const isReceivable = tx.type === "receivable" || isReturnLike;
                      const isReceivableMinus = isReturnLike;
                      const isIncome = tx.type === "income";
                      const isExpense = tx.type === "expense";
                      const isManual = tx.customer_id === null && (isIncome || isExpense);
                      const isVatCollection = tx.source === "vat_collection";
                      const isCreditApply = tx.source === "credit_apply" || tx.source === "purchase";
                      // 매입충당 행은 method=NULL 박제 → 거래처 default_payment_method 로 결제수단 추정
                      // (사장 정책 2026-05-12: 매입충당 시 거래처 결제수단 컬럼에 supply 표시)
                      const effectiveMethod = isCreditApply ? (tx.customers?.default_payment_method ?? null) : tx.method;
                      // 결제수단 컬럼은 supply 행만 표시 (vat 행은 부가세 컬럼에).
                      const supply = Math.abs(tx.amount);
                      const showInPaymentColumn = !isVatRow && !isManual && (isIncome || isExpense) && !isVatCollection && !isReturnLike;
                      return (
                        <tr key={tx.id} className="border-b border-gray-100 hover:bg-gray-50">
                          <td className="px-3 py-2 text-xs text-gray-500 whitespace-nowrap">{formatDate(tx.transaction_date)}</td>
                          {isAllSelected && (
                            <td className="px-3 py-2 text-xs font-medium text-gray-700 whitespace-nowrap">
                              {tx.customers?.company_name ?? "—"}
                            </td>
                          )}
                          <td className="px-3 py-2">
                            <div className="flex items-center gap-1.5">
                              <span className={`text-xs font-medium ${color}`}>{label}</span>
                              {tx.method && !isVatCollection && (
                                <span className={`text-xs ${methodColor(tx.method)}`}>{methodLabel(tx.method)}</span>
                              )}
                            </div>
                          </td>
                          <td className="px-3 py-2 text-right text-xs">
                            {/* 161 판매/취소 컬럼은 vat_type='supply' 행만. vat 행은 부가세 컬럼에. */}
                            {!isVatRow && isReceivable
                              ? <span className={`font-medium ${isReceivableMinus || tx.amount < 0 ? "text-rose-500" : "text-gray-800"}`}>
                                  {isReceivableMinus || tx.amount < 0 ? "−" : ""}{krw(supply)}
                                </span>
                              : <span className="text-gray-200">—</span>}
                          </td>
                          <td className="px-3 py-2 text-right text-xs">
                            {showInPaymentColumn && effectiveMethod === "cash" && supply > 0
                              ? <span className={`font-medium ${isCreditApply ? "text-gray-400 italic" : (isExpense ? "text-rose-500" : "text-green-600")}`}>
                                  {isExpense ? "−" : ""}{krw(supply)}
                                </span>
                              : <span className="text-gray-200">—</span>}
                          </td>
                          <td className="px-3 py-2 text-right text-xs">
                            {showInPaymentColumn && effectiveMethod === "transfer" && supply > 0
                              ? <span className={`font-medium ${isCreditApply ? "text-gray-400 italic" : (isExpense ? "text-rose-500" : "text-primary")}`}>
                                  {isExpense ? "−" : ""}{krw(supply)}
                                </span>
                              : <span className="text-gray-200">—</span>}
                          </td>
                          <td className="px-3 py-2 text-right text-xs">
                            {showInPaymentColumn && effectiveMethod === "credit" && supply > 0
                              ? <span className={`font-medium ${isCreditApply ? "text-gray-400 italic" : (isExpense ? "text-rose-500" : "text-purple-600")}`}>
                                  {isExpense ? "−" : ""}{krw(supply)}
                                </span>
                              : <span className="text-gray-200">—</span>}
                          </td>
                          <td className="px-3 py-2 text-right text-xs">
                            {isManual
                              ? <span className={`font-medium ${isExpense ? "text-rose-500" : "text-emerald-600"}`}>
                                  {isExpense ? "−" : "+"}{krw(tx.amount)}
                                </span>
                              : <span className="text-gray-200">—</span>}
                          </td>
                          {/* 162 부가세 컬럼 — vat 행 (standalone) 또는 supply 행의 merged vat_amount. */}
                          <td className="px-3 py-2 text-right text-xs">
                            {(() => {
                              const vatToShow = isVatRow ? Math.abs(tx.amount) : (tx.vat_amount ?? 0);
                              if (vatToShow <= 0) return <span className="text-gray-200">—</span>;
                              const isMinus = isExpense || isReturnLike || tx.amount < 0;
                              const colorCls = isCreditApply ? "text-gray-400 italic" : (isMinus ? "text-rose-500" : "text-orange-600");
                              return (
                                <span className={`font-medium ${colorCls}`}>
                                  {isMinus ? "−" : ""}{krw(vatToShow)}
                                </span>
                              );
                            })()}
                          </td>
                          <td className="px-3 py-2 text-xs text-gray-400 max-w-[140px] truncate">
                            {tx.description ?? ""}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </>
              );
            })()}
          </DataTable>
        </div>
      </div>

    </div>
  );
}
