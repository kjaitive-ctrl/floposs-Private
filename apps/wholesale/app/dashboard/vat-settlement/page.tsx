"use client";

// 부가세 정산 — 매월 1일~말일 거래처별 부가세 발행/입금 현황.
//
// 진실 출처: transactions 박제값. customers.include_vat 현재값에 의존하지 않음.
//   (월 도중 토글이 바뀌어도 거래 시점 vat_amount/vat_mode 박제는 거래마다 정확히 보존됨)
//
// 데이터: transactions WHERE source IN ('payment','vat_collection') (income+expense 모두)
//   - income (payment): 입금분, vat_amount 박제 (087/089)
//   - income (vat_collection): 별도 vat 정산 입금 (092)
//   - expense (payment): 환불, vat_amount 함께 차감
//
// 거래처별 집계 (net):
//   supply_paid       = SUM(±(amount - vat_amount))    // income +, expense - / 받은 순공급가
//   vat_paid          = SUM(±vat_amount)               // 받은 순부가세
//   vat_to_invoice    = round(supply_paid / 10)        // 발행해야할 부가세 (잠재)
//   vat_outstanding   = vat_to_invoice - vat_paid      // 받아야할 부가세 (월초 발행 결정 대상)
//
// 신고제외 (말소): vat_period_skips(거래처×월) 토글. 박제값은 보존, 합계에서만 제외.
// 일괄 입금처리: 선택 거래처마다 process_vat_collection RPC 호출 → vat_collection 박제.
// 영업개시 필요 (transactions 가 biz_session_id NOT NULL).

import { useState, useEffect, useMemo, useCallback } from "react";
import { supabase } from "@/lib/supabase";
import { useTenantId } from "@/lib/useTenant";
import { krw } from "@/lib/format";
import { ensureBizOpen } from "@/lib/bizSession";
import { DataTable, TableHead, Th, EmptyRow, LoadingRow, PageHeader, SelectTh, SelectTd } from "../_components/DataTable";

type Row = {
  customer_id: string;
  company_name: string;
  business_name: string | null;
  default_payment_method: string;
  include_vat_now: boolean;
  total_amount: number;       // 입금합계 (net, 부가세 포함)
  vat_paid: number;           // 받은 부가세 (net)
  supply_paid: number;        // 받은 공급가 (net)
  vat_to_invoice: number;     // 잠재 부가세 = supply_paid / 10
  vat_outstanding: number;    // 부족분 = vat_to_invoice - vat_paid
  skipped: boolean;           // 신고제외 여부 (vat_period_skips)
};

type TxJoin = {
  customer_id: string;
  amount: number;
  vat_type: "supply" | "vat";   // 161
  source: string;
  type: "income" | "expense";
  customers: {
    company_name: string;
    business_name: string | null;
    default_payment_method: string;
    include_vat: boolean;
  } | null;
};

function currentMonth(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

function monthRange(yearMonth: string): { from: string; to: string } {
  const [y, m] = yearMonth.split("-").map(Number);
  const from = `${y}-${String(m).padStart(2, "0")}-01`;
  const to = m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, "0")}-01`;
  return { from, to };
}

export default function VatSettlementPage() {
  const tenantId = useTenantId();
  const [yearMonth, setYearMonth] = useState(() => currentMonth());
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [amounts, setAmounts] = useState<Record<string, string>>({});
  const [processing, setProcessing] = useState(false);
  const [skipBusy, setSkipBusy] = useState<Set<string>>(new Set());

  const fetchRows = useCallback(async (tid: string, ym: string) => {
    setLoading(true);
    setSelectedIds(new Set());
    const { from, to } = monthRange(ym);

    const [txRes, skipRes] = await Promise.all([
      supabase
        .from("transactions")
        .select(`
          customer_id, amount, vat_type, source, type,
          customers!inner(company_name, business_name, default_payment_method, include_vat)
        `)
        .eq("tenant_id", tid)
        // 162: vat ledger 분리 — vat_type='supply'/'vat' 행이 별도. 모두 fetch 해서 분리 합산.
        // 환불 (source='refund', type='expense') + 매입금 충당 (source='credit_apply') 도 VAT 집계 대상.
        // credit_apply: 매입금으로 vat 충당된 분 (현금주의 vat 신고 ledger).
        .in("source", ["payment", "vat_collection", "refund", "credit_apply"])
        .gte("transaction_date", from)
        .lt("transaction_date", to),
      // RPC로 감싸서 GRANT/RLS/schema-cache 의존성 제거 (099)
      supabase.rpc("list_vat_period_skips", {
        p_tenant_id:    tid,
        p_period_month: ym,
      }),
    ]);

    if (skipRes.error) {
      console.error("[vat-settlement] list_vat_period_skips error:", skipRes.error);
    }
    if (!txRes.data) { setRows([]); setAmounts({}); setLoading(false); return; }
    const skipSet = new Set<string>(
      ((skipRes.data ?? []) as Array<{ customer_id: string }>).map(r => r.customer_id)
    );

    const txs = txRes.data as unknown as TxJoin[];
    const byCustomer = new Map<string, Row>();
    for (const t of txs) {
      if (!t.customers) continue;
      // 161: vat_type 별 행 분리. supply 행 → supply_paid / vat 행 → vat_paid.
      const sign = t.type === "expense" ? -1 : 1;
      const isVatRow = t.vat_type === "vat";
      const supply = isVatRow ? 0 : sign * t.amount;
      const vat    = isVatRow ? sign * t.amount : 0;
      const total  = sign * t.amount;
      const ex = byCustomer.get(t.customer_id);
      if (ex) {
        ex.total_amount += total;
        ex.vat_paid += vat;
        ex.supply_paid += supply;
      } else {
        byCustomer.set(t.customer_id, {
          customer_id: t.customer_id,
          company_name: t.customers.company_name,
          business_name: t.customers.business_name,
          default_payment_method: t.customers.default_payment_method,
          include_vat_now: t.customers.include_vat,
          total_amount: total,
          vat_paid: vat,
          supply_paid: supply,
          vat_to_invoice: 0,
          vat_outstanding: 0,
          skipped: false,
        });
      }
    }

    const list = Array.from(byCustomer.values())
      .filter(r => r.supply_paid > 0 || r.vat_paid !== 0)   // net 0 거래처는 표시 X
      .map(r => {
        const vat_to_invoice = Math.max(0, Math.round(r.supply_paid / 10));
        return {
          ...r,
          vat_to_invoice,
          vat_outstanding: vat_to_invoice - r.vat_paid,
          skipped: skipSet.has(r.customer_id),
        };
      })
      .sort((a, b) => {
        // skipped 는 아래로
        if (a.skipped !== b.skipped) return a.skipped ? 1 : -1;
        return b.vat_outstanding - a.vat_outstanding;
      });

    setRows(list);
    const map: Record<string, string> = {};
    for (const r of list) {
      map[r.customer_id] = r.vat_outstanding > 0 && !r.skipped ? r.vat_outstanding.toLocaleString() : "";
    }
    setAmounts(map);
    setLoading(false);
  }, []);

  useEffect(() => {
    if (!tenantId) return;
    fetchRows(tenantId, yearMonth);
  }, [tenantId, yearMonth, fetchRows]);

  const eligibleIds = useMemo(
    () => rows.filter(r => r.vat_outstanding > 0 && !r.skipped).map(r => r.customer_id),
    [rows]
  );

  function toggleSelect(id: string) {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleSelectAll() {
    if (selectedIds.size === eligibleIds.length && eligibleIds.length > 0) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(eligibleIds));
    }
  }

  const totalSelected = useMemo(() => {
    let sum = 0;
    for (const id of selectedIds) {
      const amt = parseInt((amounts[id] ?? "").replace(/,/g, ""), 10);
      if (!isNaN(amt)) sum += amt;
    }
    return sum;
  }, [selectedIds, amounts]);

  async function handleProcess() {
    if (!tenantId || selectedIds.size === 0) return;
    const opened = await ensureBizOpen();
    if (!opened) return;

    setProcessing(true);
    let success = 0;
    const failures: string[] = [];

    for (const cid of selectedIds) {
      const row = rows.find(r => r.customer_id === cid);
      if (!row) continue;
      const amtStr = (amounts[cid] ?? "").replace(/,/g, "");
      const amt = parseInt(amtStr, 10);
      if (!amt || amt <= 0) continue;

      // 결제수단: 거래처 기본값. 단 'credit'은 부가세 별도 입금 시 의미 없으므로 'transfer' 폴백.
      const method = row.default_payment_method === "credit" ? "transfer" : row.default_payment_method;

      const { error } = await supabase.rpc("process_vat_collection", {
        p_tenant_id: tenantId,
        p_customer_id: cid,
        p_amount: amt,
        p_method: method,
        p_period_month: yearMonth,
      });
      if (error) failures.push(`${row.company_name}: ${error.message}`);
      else success++;
    }

    setProcessing(false);
    if (failures.length > 0) {
      alert(`처리 완료: 성공 ${success}건 / 실패 ${failures.length}건\n\n${failures.join("\n")}`);
    }
    fetchRows(tenantId, yearMonth);
  }

  async function handleToggleSkip(row: Row) {
    if (!tenantId) return;
    const willSkip = !row.skipped;
    const confirmMsg = willSkip
      ? `${row.company_name} 의 ${yearMonth} 부가세를 신고제외(말소) 처리할까요?\n\n발생한 거래 기록은 보존되지만, 신고 합계에서 제외됩니다.`
      : `${row.company_name} 의 ${yearMonth} 신고제외를 해제할까요?\n\n다시 정상 신고 대상이 됩니다.`;
    if (!window.confirm(confirmMsg)) return;

    setSkipBusy(prev => new Set(prev).add(row.customer_id));
    const { error } = await supabase.rpc("toggle_vat_period_skip", {
      p_tenant_id:    tenantId,
      p_customer_id:  row.customer_id,
      p_period_month: yearMonth,
      p_skip:         willSkip,
      p_memo:         null,
    });
    setSkipBusy(prev => {
      const next = new Set(prev);
      next.delete(row.customer_id);
      return next;
    });
    if (error) { alert("처리 오류: " + error.message); return; }

    // RPC 성공 → 즉시 UI 반영. fetchRows 는 호출 X
    // (PostgREST schema cache 미반영 시 vat_period_skips SELECT 빈 결과 → optimistic 덮어쓰기 위험)
    // 페이지 재진입 / month 변경 시 fetchRows 가 정상 동작 (그때는 cache 안정).
    setRows(prev => prev.map(r =>
      r.customer_id === row.customer_id ? { ...r, skipped: willSkip } : r
    ));
    setSelectedIds(prev => {
      if (!willSkip) return prev;
      const next = new Set(prev);
      next.delete(row.customer_id);
      return next;
    });
  }

  function pmLabel(pm: string) {
    if (pm === "cash") return "현금";
    if (pm === "transfer") return "통장";
    if (pm === "credit") return "청구";
    return pm;
  }

  function pmColor(pm: string) {
    if (pm === "cash") return "text-green-600";
    if (pm === "transfer") return "text-primary";
    if (pm === "credit") return "text-purple-600";
    return "text-gray-500";
  }

  // 합계: skipped 거래처는 신고 합계에서 제외 (참고: 받은 공급가/부가세는 실제 거래라 표시는 유지)
  const totals = useMemo(() => {
    let supply = 0, vatPaid = 0, vatInvoice = 0, vatOut = 0;
    for (const r of rows) {
      supply += r.supply_paid;
      vatPaid += r.vat_paid;
      if (r.skipped) continue;
      vatInvoice += r.vat_to_invoice;
      vatOut += Math.max(0, r.vat_outstanding);
    }
    return { supply, vatPaid, vatInvoice, vatOut };
  }, [rows]);

  return (
    <div className="p-8 flex flex-col" style={{ minHeight: "calc(100vh - 64px)" }}>
      <PageHeader title="부가세 정산">
        <input
          type="month"
          value={yearMonth}
          onChange={e => setYearMonth(e.target.value)}
          className="input-sm"
        />
      </PageHeader>

      {/* 월별 요약 */}
      <div className="grid grid-cols-4 gap-3 mb-4">
        <div className="px-4 py-3 bg-white border border-gray-200 rounded-xl">
          <p className="text-xs text-gray-500">받은 공급가</p>
          <p className="text-lg font-semibold text-gray-900 mt-0.5">{krw(totals.supply)}</p>
        </div>
        <div className="px-4 py-3 bg-white border border-gray-200 rounded-xl">
          <p className="text-xs text-gray-500">발행해야할 부가세 <span className="text-gray-300">(신고제외 제외)</span></p>
          <p className="text-lg font-semibold text-gray-900 mt-0.5">{krw(totals.vatInvoice)}</p>
        </div>
        <div className="px-4 py-3 bg-white border border-gray-200 rounded-xl">
          <p className="text-xs text-gray-500">받은 부가세</p>
          <p className="text-lg font-semibold text-emerald-600 mt-0.5">{krw(totals.vatPaid)}</p>
        </div>
        <div className="px-4 py-3 bg-white border border-rose-200 rounded-xl bg-rose-50/30">
          <p className="text-xs text-rose-500">받아야할 부가세</p>
          <p className="text-lg font-semibold text-rose-600 mt-0.5">{krw(totals.vatOut)}</p>
        </div>
      </div>

      {/* 테이블 */}
      <DataTable maxHeight="calc(100vh - 380px)">
        <TableHead>
          <SelectTh
            checked={eligibleIds.length > 0 && selectedIds.size === eligibleIds.length}
            onChange={toggleSelectAll}
          />
          <Th>거래처</Th>
          <Th>상호명</Th>
          <Th>결제수단</Th>
          <Th className="text-right">입금합계</Th>
          <Th className="text-right">공급가</Th>
          <Th className="text-right">받은 부가세</Th>
          <Th className="text-right">발행할 부가세</Th>
          <Th className="text-right">받아야할 부가세</Th>
          <Th className="text-right">입금액</Th>
          <Th className="text-center">신고</Th>
        </TableHead>
        <tbody>
          {loading && <LoadingRow colSpan={11} />}
          {!loading && rows.length === 0 && <EmptyRow colSpan={11} message="해당 월 거래 없음" />}
          {!loading && rows.map(r => {
            const isPaid = r.vat_outstanding <= 0;
            const selected = selectedIds.has(r.customer_id);
            const busy = skipBusy.has(r.customer_id);
            const rowCls = r.skipped
              ? "bg-gray-50 text-gray-400"
              : selected ? "bg-purple-50" : "hover:bg-gray-50";
            return (
              <tr key={r.customer_id} className={`border-b border-gray-100 ${rowCls}`}>
                {(isPaid || r.skipped) ? (
                  <td className="px-5 py-3 text-center text-gray-300 text-xs">—</td>
                ) : (
                  <SelectTd checked={selected} onToggle={() => toggleSelect(r.customer_id)} />
                )}
                <td className="px-4 py-3 font-medium">
                  <span className={r.skipped ? "line-through" : "text-gray-900"}>{r.company_name}</span>
                </td>
                <td className={`px-4 py-3 text-sm ${r.skipped ? "text-gray-300" : "text-gray-600"}`}>
                  {r.business_name || "-"}
                </td>
                <td className={`px-4 py-3 text-xs font-medium ${r.skipped ? "text-gray-400" : pmColor(r.default_payment_method)}`}>
                  {pmLabel(r.default_payment_method)}
                </td>
                <td className="px-4 py-3 text-right">{krw(r.total_amount)}</td>
                <td className="px-4 py-3 text-right">{krw(r.supply_paid)}</td>
                <td className={`px-4 py-3 text-right ${r.skipped ? "" : "text-emerald-600"}`}>{krw(r.vat_paid)}</td>
                <td className="px-4 py-3 text-right text-gray-500">{krw(r.vat_to_invoice)}</td>
                <td className="px-4 py-3 text-right">
                  {r.skipped ? (
                    <span className="text-xs text-gray-300">제외</span>
                  ) : isPaid ? (
                    <span className="text-xs text-gray-300">정산완료</span>
                  ) : (
                    <span className="text-rose-600 font-semibold">{krw(r.vat_outstanding)}</span>
                  )}
                </td>
                <td className="px-4 py-3 text-right">
                  <input
                    type="text"
                    disabled={isPaid || r.skipped}
                    value={amounts[r.customer_id] ?? ""}
                    onChange={e => {
                      const raw = e.target.value.replace(/[^0-9]/g, "");
                      const num = parseInt(raw, 10);
                      setAmounts(prev => ({
                        ...prev,
                        [r.customer_id]: isNaN(num) ? "" : num.toLocaleString(),
                      }));
                    }}
                    className="w-28 px-2 py-1 border border-gray-300 rounded text-right text-sm focus:outline-none focus:ring-2 focus:ring-purple-400 disabled:bg-gray-100 disabled:text-gray-400"
                  />
                </td>
                <td className="px-3 py-3 text-center">
                  <button
                    onClick={() => handleToggleSkip(r)}
                    disabled={busy}
                    title={r.skipped ? "신고제외 해제" : "이번 달 신고에서 제외(말소)"}
                    className={`px-2 py-0.5 text-xs font-medium rounded border ${
                      r.skipped
                        ? "bg-gray-100 text-gray-500 border-gray-300 hover:bg-gray-200"
                        : "bg-white text-rose-600 border-rose-200 hover:bg-rose-50"
                    } disabled:opacity-50`}
                  >
                    {busy ? "..." : r.skipped ? "복구" : "제외"}
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </DataTable>

      {/* 일괄 처리 바 */}
      <div className="mt-3 flex items-center justify-between bg-white border border-gray-200 rounded-xl px-4 py-3">
        <div className="text-sm text-gray-500">
          {selectedIds.size > 0
            ? <span><b className="text-gray-900">{selectedIds.size}건</b> 선택됨 · 총 <b className="text-gray-900">{krw(totalSelected)}</b></span>
            : <span className="text-gray-400">미정산 거래처를 선택하세요</span>}
        </div>
        <button
          onClick={handleProcess}
          disabled={processing || selectedIds.size === 0 || totalSelected === 0}
          className="px-6 py-2 text-sm font-semibold text-white rounded-lg bg-credit hover:bg-credit-hover disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {processing ? "처리 중..." : `${selectedIds.size}건 입금처리`}
        </button>
      </div>
    </div>
  );
}
