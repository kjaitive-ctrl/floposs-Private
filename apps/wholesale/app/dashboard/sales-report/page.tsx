"use client";

import { useState, useEffect, useMemo } from "react";
import { supabase } from "@/lib/supabase";
import { useTenantId } from "@/lib/useTenant";
import { krw, APP_TIMEZONE } from "@/lib/format";
import { PageHeader, PageActionBar, PAGE_ACTION_BAR_SPACER } from "../_components/DataTable";

type Period = "this_month" | "last_month" | "this_year" | "custom";

// 074에서 추가된 캐시 컬럼만 select (전체는 무거움)
type SessionRow = {
  id: string;
  opened_at: string;
  closed_at: string | null;
  opener_name: string;
  closer_name: string | null;
  sales_count: number;
  sales_amount: number;
  returns_count: number;
  returns_amount: number;
  purchase_count: number;
  purchase_amount: number;
  cash_in_amount: number;
  transfer_in_amount: number;
  credit_amount: number;
  manual_in_amount: number;
  manual_out_amount: number;
  vat_total: number;
  inbound_count: number;
  inbound_amount: number;
  customer_count: number;
};

type CustomerStat = {
  biz_session_id: string;
  customer_id: string | null;
  customer_name: string;
  sales_count: number;
  sales_amount: number;
  returns_count: number;
  returns_amount: number;
  purchase_count: number;
  purchase_amount: number;
};

type ProductStat = {
  biz_session_id: string;
  variant_id: string | null;
  product_id: string | null;
  product_name: string;
  color: string | null;
  size: string | null;
  qty: number;
  amount: number;
};

const SESSION_COLS =
  "id, opened_at, closed_at, opener_name, closer_name, " +
  "sales_count, sales_amount, returns_count, returns_amount, " +
  "purchase_count, purchase_amount, cash_in_amount, transfer_in_amount, credit_amount, " +
  "manual_in_amount, manual_out_amount, vat_total, inbound_count, inbound_amount, customer_count";

// ── 기간 계산 (KST 자정 기준, biz_sessions.opened_at에 적용) ──
function getPeriodRange(period: Period, customFrom?: string, customTo?: string) {
  const now = new Date();
  const kstNow = new Date(now.toLocaleString("en-US", { timeZone: APP_TIMEZONE }));
  const y = kstNow.getFullYear();
  const m = kstNow.getMonth();

  if (period === "this_month")  return { from: new Date(y, m, 1),     to: new Date(y, m + 1, 1) };
  if (period === "last_month")  return { from: new Date(y, m - 1, 1), to: new Date(y, m, 1) };
  if (period === "this_year")   return { from: new Date(y, 0, 1),     to: new Date(y + 1, 0, 1) };
  return {
    from: customFrom ? new Date(customFrom) : new Date(y, m, 1),
    to:   customTo
            ? new Date(new Date(customTo).getTime() + 24 * 60 * 60 * 1000)
            : new Date(y, m + 1, 1),
  };
}

function toKSTDate(iso: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: APP_TIMEZONE,
    year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date(iso));
}

function toKSTHHMM(iso: string): string {
  return new Intl.DateTimeFormat("ko-KR", {
    timeZone: APP_TIMEZONE,
    hour: "2-digit", minute: "2-digit", hour12: false,
  }).format(new Date(iso));
}

export default function SalesReportPage() {
  const [period, setPeriod] = useState<Period>("this_month");
  const [customFrom, setCustomFrom] = useState("");
  const [customTo, setCustomTo] = useState("");
  const tenantId = useTenantId();
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [custStats, setCustStats] = useState<CustomerStat[]>([]);
  const [prodStats, setProdStats] = useState<ProductStat[]>([]);
  const [loading, setLoading] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const { from, to } = useMemo(
    () => getPeriodRange(period, customFrom, customTo),
    [period, customFrom, customTo]
  );

  // 세션 + 거래처별 + 상품별 stats를 캐시 테이블에서만 가져옴
  useEffect(() => {
    if (!tenantId) return;
    setLoading(true);
    (async () => {
      const { data: sessData } = await supabase
        .from("biz_sessions")
        .select(SESSION_COLS)
        .eq("tenant_id", tenantId)
        .eq("status", "closed")
        .not("stats_finalized_at", "is", null)
        .gte("opened_at", from.toISOString())
        .lt("opened_at", to.toISOString())
        .order("opened_at", { ascending: false });

      const sess = (sessData ?? []) as unknown as SessionRow[];
      setSessions(sess);

      if (sess.length === 0) {
        setCustStats([]);
        setProdStats([]);
        setLoading(false);
        return;
      }

      const ids = sess.map(s => s.id);
      const [{ data: cData }, { data: pData }] = await Promise.all([
        supabase.from("biz_session_customer_stats")
          .select("biz_session_id, customer_id, customer_name, sales_count, sales_amount, returns_count, returns_amount, purchase_count, purchase_amount")
          .in("biz_session_id", ids),
        supabase.from("biz_session_product_stats")
          .select("biz_session_id, variant_id, product_id, product_name, color, size, qty, amount")
          .in("biz_session_id", ids),
      ]);
      setCustStats((cData ?? []) as unknown as CustomerStat[]);
      setProdStats((pData ?? []) as unknown as ProductStat[]);
      setLoading(false);
    })();
  }, [tenantId, from, to]);

  // ── 집계 (모두 캐시 데이터에서 도출) ───────────────────────
  const stats = useMemo(() => {
    const sessionCount = sessions.length;
    const totalSales   = sessions.reduce((s, x) => s + x.sales_amount - x.returns_amount, 0);
    const totalSalesGross = sessions.reduce((s, x) => s + x.sales_amount, 0);
    const totalReturns = sessions.reduce((s, x) => s + x.returns_amount, 0);
    const orderCount   = sessions.reduce((s, x) => s + x.sales_count, 0);
    const cashTotal     = sessions.reduce((s, x) => s + x.cash_in_amount,     0);
    const transferTotal = sessions.reduce((s, x) => s + x.transfer_in_amount, 0);
    const creditTotal   = sessions.reduce((s, x) => s + x.credit_amount,      0);
    const inboundTotal  = sessions.reduce((s, x) => s + x.inbound_amount,     0);
    const vatTotal      = sessions.reduce((s, x) => s + x.vat_total,          0);
    const avgSession    = sessionCount ? totalSales / sessionCount : 0;
    const paymentSum    = cashTotal + transferTotal + creditTotal;

    // 거래처별 기간 누적
    const byCustomer = new Map<string, { id: string; name: string; sessions: number; sales: number; returns: number; purchase: number }>();
    for (const c of custStats) {
      const key = c.customer_id ?? `name:${c.customer_name}`;
      const cur = byCustomer.get(key) ?? { id: key, name: c.customer_name, sessions: 0, sales: 0, returns: 0, purchase: 0 };
      cur.sessions += 1;
      cur.sales    += c.sales_amount;
      cur.returns  += c.returns_amount;
      cur.purchase += c.purchase_amount;
      byCustomer.set(key, cur);
    }
    const customerRows = [...byCustomer.values()].sort((a, b) => b.sales - a.sales);

    // 상품별 기간 누적 (variant 단위)
    const byVariant = new Map<string, { key: string; name: string; color: string | null; size: string | null; qty: number; amount: number }>();
    for (const p of prodStats) {
      const key = p.variant_id ?? `name:${p.product_name}-${p.color ?? ""}-${p.size ?? ""}`;
      const cur = byVariant.get(key) ?? { key, name: p.product_name, color: p.color, size: p.size, qty: 0, amount: 0 };
      cur.qty    += p.qty;
      cur.amount += p.amount;
      byVariant.set(key, cur);
    }
    const productRows = [...byVariant.values()].sort((a, b) => b.amount - a.amount);

    return {
      sessionCount, totalSales, totalSalesGross, totalReturns, orderCount,
      cashTotal, transferTotal, creditTotal, inboundTotal, vatTotal,
      avgSession, paymentSum,
      customerCount: customerRows.length,
      customerRows, productRows,
    };
  }, [sessions, custStats, prodStats]);

  // 세션 단위 거래처 펼치기 인덱스
  const customerStatsBySession = useMemo(() => {
    const m = new Map<string, CustomerStat[]>();
    for (const c of custStats) {
      const arr = m.get(c.biz_session_id) ?? [];
      arr.push(c);
      m.set(c.biz_session_id, arr);
    }
    for (const [, arr] of m) arr.sort((a, b) => b.sales_amount - a.sales_amount);
    return m;
  }, [custStats]);

  const maxSessionAmount = Math.max(...sessions.map(s => s.sales_amount - s.returns_amount), 1);

  function toggleSession(id: string) {
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  // ── CSV 다운로드 ────────────────────────────────────
  function downloadCSV() {
    const rows: string[] = [];
    const periodLabel =
      period === "this_month" ? "이번달" :
      period === "last_month" ? "전월" :
      period === "this_year"  ? "올해" : "직접지정";
    rows.push(`매출리포트(세션 기준) - ${periodLabel} (${from.toISOString().slice(0,10)} ~ ${new Date(to.getTime()-1).toISOString().slice(0,10)})`);
    rows.push("");
    rows.push("=== 요약 ===");
    rows.push(`총매출(반품반영),${stats.totalSales}`);
    rows.push(`판매계,${stats.totalSalesGross}`);
    rows.push(`반품계,${stats.totalReturns}`);
    rows.push(`세션수,${stats.sessionCount}`);
    rows.push(`주문수,${stats.orderCount}`);
    rows.push(`거래처수,${stats.customerCount}`);
    rows.push(`평균세션매출,${Math.round(stats.avgSession)}`);
    rows.push(`현금,${stats.cashTotal}`);
    rows.push(`통장,${stats.transferTotal}`);
    rows.push(`외상,${stats.creditTotal}`);
    rows.push(`입고,${stats.inboundTotal}`);
    rows.push(`부가세,${stats.vatTotal}`);
    rows.push("");
    rows.push("=== 세션별 ===");
    rows.push("개시일,개시시각,개시자,마감자,주문수,판매,반품,순매출,거래처수");
    sessions.forEach(s => {
      rows.push([
        toKSTDate(s.opened_at),
        toKSTHHMM(s.opened_at),
        s.opener_name,
        s.closer_name ?? "",
        s.sales_count,
        s.sales_amount,
        s.returns_amount,
        s.sales_amount - s.returns_amount,
        s.customer_count,
      ].join(","));
    });
    rows.push("");
    rows.push("=== 거래처별 (기간 합산) ===");
    rows.push("거래처,세션수,판매,반품,매입");
    stats.customerRows.forEach(r => rows.push(`${r.name},${r.sessions},${r.sales},${r.returns},${r.purchase}`));
    rows.push("");
    rows.push("=== 상품별 (기간 합산) ===");
    rows.push("상품,수량,금액");
    stats.productRows.forEach(r => {
      const name = `${r.name}${r.color ? ` · ${r.color}` : ""}${r.size ? ` · ${r.size}` : ""}`;
      rows.push(`${name},${r.qty},${r.amount}`);
    });

    const csv = "﻿" + rows.join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement("a");
    a.href     = url;
    a.download = `매출리포트_${from.toISOString().slice(0,10)}_${new Date(to.getTime()-1).toISOString().slice(0,10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className={`space-y-6 ${PAGE_ACTION_BAR_SPACER}`}>
      <PageHeader title="매출리포트" subtitle="정산완료 세션 기준 · 영업개시일(KST) 그루핑" />

      {/* 기간 필터 */}
      <div className="flex items-center gap-2 flex-wrap">
        {([
          ["this_month", "이번 달"],
          ["last_month", "전월"],
          ["this_year",  "올해"],
          ["custom",     "직접지정"],
        ] as [Period, string][]).map(([k, label]) => (
          <button
            key={k}
            onClick={() => setPeriod(k)}
            className={`px-4 py-1.5 rounded-lg text-xs font-medium border transition-colors ${
              period === k
                ? "bg-primary text-white border-primary"
                : "bg-white text-gray-600 border-gray-200 hover:border-gray-300"
            }`}
          >
            {label}
          </button>
        ))}
        {period === "custom" && (
          <div className="flex items-center gap-1.5 ml-2">
            <input type="date" value={customFrom}
              onChange={e => setCustomFrom(e.target.value)}
              className="px-2.5 py-1.5 border border-gray-200 rounded-lg text-xs focus:outline-none focus:ring-2 focus:ring-primary-ring" />
            <span className="text-gray-400 text-xs">~</span>
            <input type="date" value={customTo}
              onChange={e => setCustomTo(e.target.value)}
              className="px-2.5 py-1.5 border border-gray-200 rounded-lg text-xs focus:outline-none focus:ring-2 focus:ring-primary-ring" />
          </div>
        )}
        <span className="ml-auto text-xs text-gray-400">
          {from.toLocaleDateString("ko-KR")} ~ {new Date(to.getTime() - 1).toLocaleDateString("ko-KR")}
        </span>
      </div>

      {/* KPI */}
      <div className="grid grid-cols-4 gap-3">
        <Kpi label="총 매출"        value={krw(stats.totalSales)}             sub={`판매 ${krw(stats.totalSalesGross)} / 반품 ${krw(stats.totalReturns)}`} />
        <Kpi label="세션 수"        value={`${stats.sessionCount}회`}         sub={`주문 ${stats.orderCount}건`} />
        <Kpi label="평균 세션 매출" value={krw(Math.round(stats.avgSession))} sub={`거래처 ${stats.customerCount}곳`} />
        <KpiPayment cash={stats.cashTotal} transfer={stats.transferTotal} credit={stats.creditTotal} />
      </div>

      {loading && <div className="text-center text-gray-400 py-8 text-sm">불러오는 중...</div>}
      {!loading && sessions.length === 0 && (
        <div className="bg-white rounded-xl border border-gray-200 p-12 text-center text-sm text-gray-400">
          이 기간에 정산완료된 세션이 없습니다.
        </div>
      )}

      {/* 세션별 (메인) */}
      {sessions.length > 0 && (
        <section className="bg-white rounded-xl border border-gray-200 p-5">
          <h2 className="text-sm font-bold text-gray-800 mb-3">세션별 매출</h2>

          {/* 세션 막대 */}
          <div className="flex items-end gap-1 h-32 mb-4 border-b border-gray-100 pb-1">
            {sessions.slice().reverse().map(s => {
              const net = s.sales_amount - s.returns_amount;
              const h = Math.max((net / maxSessionAmount) * 100, 2);
              return (
                <div key={s.id}
                  className="flex-1 flex flex-col justify-end items-center"
                  title={`${toKSTDate(s.opened_at)} ${toKSTHHMM(s.opened_at)} · ${krw(net)} · ${s.sales_count}건`}>
                  <div className="w-full bg-primary-ring hover:bg-primary rounded-t transition-colors"
                    style={{ height: `${h}%` }} />
                </div>
              );
            })}
          </div>

          {/* 세션 테이블 (펼치면 거래처별 미니) */}
          <table className="w-full text-sm">
            <thead>
              <tr>
                <th className={thCls}>개시일</th>
                <th className={thCls}>개시시각</th>
                <th className={thCls}>근무자</th>
                <th className={`${thCls} text-center`}>거래처</th>
                <th className={`${thCls} text-center`}>주문</th>
                <th className={`${thCls} text-right`}>판매</th>
                <th className={`${thCls} text-right`}>반품</th>
                <th className={`${thCls} text-right`}>순매출</th>
              </tr>
            </thead>
            <tbody>
              {sessions.flatMap(s => {
                const isOpen = expanded.has(s.id);
                const net = s.sales_amount - s.returns_amount;
                const head = (
                  <tr key={s.id}
                      className="hover:bg-gray-50 cursor-pointer border-b border-gray-100"
                      onClick={() => toggleSession(s.id)}>
                    <td className={`${tdCls} font-medium`}>
                      <span className="inline-block w-3 text-gray-400">{isOpen ? "▾" : "▸"}</span>
                      <span className="ml-1">{toKSTDate(s.opened_at)}</span>
                    </td>
                    <td className={`${tdCls} text-gray-500 tabular-nums`}>{toKSTHHMM(s.opened_at)}</td>
                    <td className={tdCls}>
                      {s.opener_name}{s.closer_name && s.closer_name !== s.opener_name ? ` → ${s.closer_name}` : ""}
                    </td>
                    <td className={`${tdCls} text-center`}>{s.customer_count}</td>
                    <td className={`${tdCls} text-center`}>{s.sales_count}</td>
                    <td className={`${tdCls} text-right`}>{krw(s.sales_amount)}</td>
                    <td className={`${tdCls} text-right text-red-500`}>{s.returns_amount ? krw(s.returns_amount) : "-"}</td>
                    <td className={`${tdCls} text-right font-medium`}>{krw(net)}</td>
                  </tr>
                );
                if (!isOpen) return [head];
                const sessionCusts = customerStatsBySession.get(s.id) ?? [];
                if (sessionCusts.length === 0) {
                  return [head, (
                    <tr key={`${s.id}-empty`} className="bg-gray-50 border-b border-gray-100">
                      <td colSpan={8} className="px-10 py-3 text-xs text-gray-400">이 세션에 거래처별 매출이 없습니다.</td>
                    </tr>
                  )];
                }
                const detail = sessionCusts.map(c => (
                  <tr key={`${s.id}-${c.customer_id ?? c.customer_name}`} className="bg-gray-50 border-b border-gray-100">
                    <td colSpan={2} className="pl-10 py-2 text-xs text-gray-500">└ {c.customer_name}</td>
                    <td className={`${tdCls} text-xs text-gray-500`}>{c.sales_count}건</td>
                    <td colSpan={2} />
                    <td className={`${tdCls} text-right text-xs text-gray-700`}>{c.sales_amount ? krw(c.sales_amount) : "-"}</td>
                    <td className={`${tdCls} text-right text-xs text-red-500`}>{c.returns_amount ? krw(c.returns_amount) : "-"}</td>
                    <td className={`${tdCls} text-right text-xs text-gray-700 font-medium`}>{krw(c.sales_amount - c.returns_amount)}</td>
                  </tr>
                ));
                return [head, ...detail];
              })}
            </tbody>
          </table>
        </section>
      )}

      {/* 거래처별 (기간 합산) */}
      {stats.customerRows.length > 0 && (
        <section className="bg-white rounded-xl border border-gray-200 p-5">
          <h2 className="text-sm font-bold text-gray-800 mb-3">거래처별 매출 (기간 합산)</h2>
          <table className="w-full text-sm">
            <thead>
              <tr>
                <th className={thCls}>거래처</th>
                <th className={`${thCls} text-center`}>세션 수</th>
                <th className={`${thCls} text-right`}>판매</th>
                <th className={`${thCls} text-right`}>반품</th>
                <th className={`${thCls} text-right`}>순매출</th>
                <th className={`${thCls} text-right`}>비중</th>
              </tr>
            </thead>
            <tbody>
              {stats.customerRows.map(r => {
                const net = r.sales - r.returns;
                return (
                  <tr key={r.id} className="hover:bg-gray-50 border-b border-gray-100">
                    <td className={`${tdCls} font-medium text-gray-900`}>{r.name}</td>
                    <td className={`${tdCls} text-center`}>{r.sessions}회</td>
                    <td className={`${tdCls} text-right`}>{krw(r.sales)}</td>
                    <td className={`${tdCls} text-right text-red-500`}>{r.returns ? krw(r.returns) : "-"}</td>
                    <td className={`${tdCls} text-right font-medium`}>{krw(net)}</td>
                    <td className={`${tdCls} text-right text-gray-500`}>
                      {stats.totalSales ? ((net / stats.totalSales) * 100).toFixed(1) : "0.0"}%
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </section>
      )}

      {/* 상품별 (기간 합산) */}
      {stats.productRows.length > 0 && (
        <section className="bg-white rounded-xl border border-gray-200 p-5">
          <h2 className="text-sm font-bold text-gray-800 mb-3">상품별 매출 (기간 합산)</h2>
          <p className="text-[10px] text-gray-400 mb-2">샘플 출고 제외 · 색상/사이즈 별 합계</p>
          <table className="w-full text-sm">
            <thead>
              <tr>
                <th className={thCls}>상품</th>
                <th className={`${thCls} text-right`}>판매 수량</th>
                <th className={`${thCls} text-right`}>판매 금액</th>
                <th className={`${thCls} text-right`}>비중</th>
              </tr>
            </thead>
            <tbody>
              {stats.productRows.map(r => {
                const name = `${r.name}${r.color ? ` · ${r.color}` : ""}${r.size ? ` · ${r.size}` : ""}`;
                return (
                  <tr key={r.key} className="hover:bg-gray-50 border-b border-gray-100">
                    <td className={`${tdCls} font-medium text-gray-900`}>{name}</td>
                    <td className={`${tdCls} text-right`}>{r.qty.toLocaleString()}개</td>
                    <td className={`${tdCls} text-right font-medium`}>{krw(r.amount)}</td>
                    <td className={`${tdCls} text-right text-gray-500`}>
                      {stats.totalSalesGross ? ((r.amount / stats.totalSalesGross) * 100).toFixed(1) : "0.0"}%
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </section>
      )}

      <PageActionBar>
        <button
          onClick={downloadCSV}
          disabled={loading || stats.sessionCount === 0}
          className="px-4 py-2 bg-gray-900 text-white rounded-lg text-xs font-semibold hover:bg-gray-700 disabled:opacity-30 transition-colors"
        >
          CSV 다운로드
        </button>
      </PageActionBar>
    </div>
  );
}

const thCls = "text-left px-3 py-2 text-[11px] font-semibold text-gray-500 uppercase bg-gray-50 border-b border-gray-200";
const tdCls = "px-3 py-2 text-sm text-gray-700";

function Kpi({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="bg-white rounded-xl border border-gray-200 p-4">
      <div className="text-[11px] text-gray-500 font-medium uppercase mb-1.5">{label}</div>
      <div className="text-lg font-bold text-gray-900">{value}</div>
      {sub && <div className="text-[10px] text-gray-400 mt-0.5">{sub}</div>}
    </div>
  );
}

function KpiPayment({ cash, transfer, credit }: { cash: number; transfer: number; credit: number }) {
  const sum = cash + transfer + credit;
  const pct = (v: number) => sum ? ((v / sum) * 100).toFixed(0) : "0";
  return (
    <div className="bg-white rounded-xl border border-gray-200 p-4">
      <div className="text-[11px] text-gray-500 font-medium uppercase mb-1.5">결제수단</div>
      {sum === 0 ? (
        <div className="text-sm text-gray-300">—</div>
      ) : (
        <div className="space-y-1">
          <div className="flex items-center justify-between text-[11px]">
            <span className="text-gray-600">현금</span>
            <span className="font-medium text-gray-900">{pct(cash)}%</span>
          </div>
          <div className="flex items-center justify-between text-[11px]">
            <span className="text-gray-600">통장</span>
            <span className="font-medium text-gray-900">{pct(transfer)}%</span>
          </div>
          <div className="flex items-center justify-between text-[11px]">
            <span className="text-gray-600">외상</span>
            <span className="font-medium text-gray-900">{pct(credit)}%</span>
          </div>
        </div>
      )}
    </div>
  );
}
