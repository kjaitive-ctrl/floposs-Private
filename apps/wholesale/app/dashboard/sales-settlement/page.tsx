"use client";

import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabase";
import { useTenantId } from "@/lib/useTenant";
import { bizOpen, bizClose, getBizSessionId } from "@/lib/bizSession";
import BizSessionOpenModal from "../_components/BizSessionOpenModal";
import BusinessSettleModal from "../_components/BusinessSettleModal";
import { PageHeader, PageActionBar, PAGE_ACTION_BAR_SPACER, Badge, DataTable, TableHead, Th, EmptyRow } from "../_components/DataTable";
import Button from "../_components/Button";

// biz_sessions 행: 074에서 추가된 통계 컬럼 포함 (closed 세션은 박제됨)
type BizSession = {
  id: string;
  opener_name: string;
  opening_cash: number;
  opened_at: string;
  closer_name: string | null;
  closing_cash: number | null;
  closed_at: string | null;
  status: "open" | "closed";
  // 통계 캐시 (status='closed' && stats_finalized_at != null 일 때만 채워짐)
  stats_finalized_at: string | null;
  sales_count: number | null;
  sales_amount: number | null;
  returns_count: number | null;
  returns_amount: number | null;
  purchase_count: number | null;
  purchase_amount: number | null;
  cash_in_count: number | null;
  cash_in_amount: number | null;
  transfer_in_count: number | null;
  transfer_in_amount: number | null;
  credit_count: number | null;
  credit_amount: number | null;
  manual_in_count: number | null;
  manual_in_amount: number | null;
  manual_out_count: number | null;
  manual_out_amount: number | null;
  vat_count: number | null;
  vat_total: number | null;
  inbound_count: number | null;
  inbound_amount: number | null;
};

type Order = {
  id: string;
  customer_id: string | null;
  customer_name: string | null;
  order_number: string | null;
  total_amount: number;
  vat_amount: number;
  outstanding_amount: number;
  payment_method: "cash" | "transfer" | "credit" | null;
  created_at: string;
};

type Tx = {
  id: string;
  customer_id: string | null;
  order_id: string | null;
  type: "income" | "expense" | "receivable" | "payable";
  amount: number;
  vat_amount: number | null;
  method: "cash" | "transfer" | "card" | "other" | null;
  source: string;
  transaction_date: string;
  customers: { company_name: string } | null;
};

type Inbound = { id: string; total_amount: number };

type Bucket = { count: number; amount: number };
const Z: Bucket = { count: 0, amount: 0 };
const add = (b: Bucket, v: number): Bucket => ({ count: b.count + 1, amount: b.amount + v });

type Summary = {
  totalSales: Bucket; sales: Bucket; returns: Bucket; purchase: Bucket;
  cashIn: Bucket; transferIn: Bucket; credit: Bucket;
  manualIn: Bucket; manualOut: Bucket; vat: Bucket; inbound: Bucket;
};

type CustomerRow = {
  customer_id: string;
  customer_name: string;
  sales: number;
  returns: number;
  purchase: number;
  orders: Order[];          // live 모드는 즉시 채워짐 / cached 모드는 펼칠 때 lazy fetch
  ordersLoaded: boolean;    // cached 모드 펼치기 1회만 fetch
};

function formatDuration(fromIso: string, toIso: string | null) {
  const ms = (toIso ? new Date(toIso).getTime() : Date.now()) - new Date(fromIso).getTime();
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  return `${h}시간 ${m}분`;
}

function toDateInputValue(iso: string) {
  const d = new Date(iso);
  const tz = new Date(d.getTime() - d.getTimezoneOffset() * 60000);
  return tz.toISOString().slice(0, 10);
}

const BIZ_COLS = "id, opener_name, opening_cash, opened_at, closer_name, closing_cash, closed_at, status, " +
  "stats_finalized_at, sales_count, sales_amount, returns_count, returns_amount, purchase_count, purchase_amount, " +
  "cash_in_count, cash_in_amount, transfer_in_count, transfer_in_amount, credit_count, credit_amount, " +
  "manual_in_count, manual_in_amount, manual_out_count, manual_out_amount, vat_count, vat_total, " +
  "inbound_count, inbound_amount";

function isCached(s: BizSession): boolean {
  return s.status === "closed" && !!s.stats_finalized_at;
}

function bucketFromCols(count: number | null, amount: number | null): Bucket {
  return { count: count ?? 0, amount: amount ?? 0 };
}

// 075 RPC와 동일한 분류 규칙 (live 모드용)
// 매출 = transactions(source='shipment') — 출고/미송 처리 시점에 refresh_order_revenue가 INSERT
// VAT = 그 세션 등록 + 그 세션에서 처리된 주문의 vat_amount (참고용 표시. 실제 발행은 입금 기준 vat_batches)
function computeSummary(orders: Order[], txs: Tx[], inbounds: Inbound[]): Summary {
  let sales = Z, returns = Z, purchase = Z;
  let cashIn = Z, transferIn = Z, credit = Z;
  let manualIn = Z, manualOut = Z;
  let vat = Z, inbound = Z;

  // 162 매트릭스: 부가세 = 실제 입출금 vat 만 (현금주의).
  //   - orders.vat_amount 합산 폐기 (출고 시점 vat 가 아닌 실제 입금분만 카운트)
  //   - transactions vat 행 중 shipment 제외 (hidden ledger), payment/refund/credit_apply 만 합산
  for (const t of txs) {
    // 162: vat ledger 분리.
    //   - vat_type='vat' 행은 부가세 합산에만, supply 행은 매출/입금 합산에.
    //   - shipment+vat 행은 hidden ledger (실제 입금 X, DB 박제용) → 영업정산 부가세 제외.
    //   - 입금/환불/충당 vat 행만 실제 입출금 부가세 (현금주의).
    const isVatRow = (t as { vat_type?: string }).vat_type === "vat";
    if (isVatRow) {
      // hidden ledger 제외: shipment+vat (출고 시점) / return+vat (반품 시점).
      // 매트릭스: 부가세 = 실제 입출금 기준 (현금주의). 매출 발생 vat 는 ledger 박제만.
      if (t.source === "shipment" || t.source === "return") continue;
      const sign = t.type === "expense" ? -1 : 1;
      vat = add(vat, sign * t.amount);
      continue;
    }

    if (t.source === "shipment") sales = add(sales, t.amount);
    else if (t.source === "return") returns = add(returns, t.amount);
    else if (t.source === "credit_apply") purchase = add(purchase, t.amount);
    else if (t.source === "manual" && !t.customer_id) {
      if (t.type === "income") manualIn = add(manualIn, t.amount);
      else if (t.type === "expense") manualOut = add(manualOut, t.amount);
    } else if (t.type === "income" && t.method === "cash") cashIn = add(cashIn, t.amount);
    else if (t.type === "income" && t.method === "transfer") transferIn = add(transferIn, t.amount);
    else if (t.type === "receivable") credit = add(credit, t.amount);
  }
  for (const i of inbounds) inbound = add(inbound, i.total_amount || 0);

  const totalSales: Bucket = { count: sales.count, amount: sales.amount - returns.amount };
  return { totalSales, sales, returns, purchase, cashIn, transferIn, credit, manualIn, manualOut, vat, inbound };
}

function summaryFromCache(s: BizSession): Summary {
  const sales      = bucketFromCols(s.sales_count, s.sales_amount);
  const returns    = bucketFromCols(s.returns_count, s.returns_amount);
  const purchase   = bucketFromCols(s.purchase_count, s.purchase_amount);
  const cashIn     = bucketFromCols(s.cash_in_count, s.cash_in_amount);
  const transferIn = bucketFromCols(s.transfer_in_count, s.transfer_in_amount);
  const credit     = bucketFromCols(s.credit_count, s.credit_amount);
  const manualIn   = bucketFromCols(s.manual_in_count, s.manual_in_amount);
  const manualOut  = bucketFromCols(s.manual_out_count, s.manual_out_amount);
  const vat        = bucketFromCols(s.vat_count, s.vat_total);
  const inbound    = bucketFromCols(s.inbound_count, s.inbound_amount);
  const totalSales: Bucket = { count: sales.count, amount: sales.amount - returns.amount };
  return { totalSales, sales, returns, purchase, cashIn, transferIn, credit, manualIn, manualOut, vat, inbound };
}

// 거래처별 합계 = transactions(shipment/return/credit_apply) 기반
// 펼치기 detail = 그 세션에 등록된 orders (참고용)
function customerRowsFromLive(orders: Order[], txs: Tx[]): CustomerRow[] {
  const map = new Map<string, CustomerRow>();

  for (const t of txs) {
    if (!t.customer_id) continue;
    if (t.source !== "shipment" && t.source !== "return" && t.source !== "credit_apply") continue;
    // 162 매트릭스: shipment+vat / return+vat 행은 hidden ledger (실 입금 X). supply 만 매출/반품 합산.
    if ((t as { vat_type?: string }).vat_type === "vat") continue;
    const key = t.customer_id;
    const name = t.customers?.company_name ?? "(미지정)";
    const row = map.get(key) ?? { customer_id: key, customer_name: name, sales: 0, returns: 0, purchase: 0, orders: [], ordersLoaded: true };
    if (t.source === "shipment")     row.sales    += t.amount;
    else if (t.source === "return")  row.returns  += t.amount;
    else                             row.purchase += t.amount;
    map.set(key, row);
  }

  // 펼치기 detail용: 그 세션에 등록된 orders를 거래처별로 묶어 첨부
  for (const o of orders) {
    if (!o.customer_id) continue;
    const row = map.get(o.customer_id);
    if (row) row.orders.push(o);
  }

  return Array.from(map.values()).sort((a, b) => b.sales - a.sales);
}

export default function SalesSettlementPage() {
  const tenantId = useTenantId();
  const [session, setSession] = useState<BizSession | null>(null);
  const [loading, setLoading] = useState(true);
  const [showOpenModal, setShowOpenModal] = useState(false);
  const [showSettleModal, setShowSettleModal] = useState(false);
  const [selectedDate, setSelectedDate] = useState<string>("");

  const [summary, setSummary] = useState<Summary | null>(null);
  const [customerRows, setCustomerRows] = useState<CustomerRow[]>([]);

  useEffect(() => {
    if (!tenantId) return;
    loadInitialSession(tenantId);
  }, [tenantId]); // eslint-disable-line react-hooks/exhaustive-deps

  // 세션이 바뀔 때마다 로드 (cached vs live 분기)
  useEffect(() => {
    if (!session) { setSummary(null); setCustomerRows([]); return; }
    if (isCached(session)) loadFromCache(session);
    else                   loadLive(session.id);
  }, [session]);

  // ── live 모드: orders/transactions/inbounds 가져와 클라이언트 집계 ──
  // status='cancelled' 제외 — 075 RPC 박제 정책과 일치
  async function loadLive(sid: string) {
    const [oRes, tRes, iRes] = await Promise.all([
      supabase.from("orders")
        .select("id, customer_id, customer_name, order_number, total_amount, vat_amount, outstanding_amount, payment_method, created_at")
        .eq("biz_session_id", sid)
        .neq("status", "cancelled")
        .order("created_at"),
      supabase.from("transactions")
        .select("id, customer_id, order_id, type, amount, vat_amount, vat_type, method, source, transaction_date, customers(company_name)")
        .eq("biz_session_id", sid),
      supabase.from("inbound_orders").select("id, total_amount").eq("biz_session_id", sid),
    ]);
    const orders = (oRes.data ?? []) as Order[];
    const txs = (tRes.data ?? []) as unknown as Tx[];
    const inbounds = (iRes.data ?? []) as Inbound[];
    setSummary(computeSummary(orders, txs, inbounds));
    setCustomerRows(customerRowsFromLive(orders, txs));
  }

  // ── cached 모드: 박제된 통계만 SELECT (펼치기 detail은 lazy fetch) ──
  async function loadFromCache(s: BizSession) {
    setSummary(summaryFromCache(s));
    const { data } = await supabase
      .from("biz_session_customer_stats")
      .select("customer_id, customer_name, sales_amount, returns_amount, purchase_amount")
      .eq("biz_session_id", s.id)
      .order("sales_amount", { ascending: false });
    const rows: CustomerRow[] = (data ?? []).map(r => ({
      customer_id: r.customer_id ?? "_",
      customer_name: r.customer_name,
      sales: r.sales_amount,
      returns: r.returns_amount,
      purchase: r.purchase_amount,
      orders: [],
      ordersLoaded: false,
    }));
    setCustomerRows(rows);
  }

  async function loadOrdersForCustomer(sid: string, customerKey: string) {
    const cid = customerKey === "_" ? null : customerKey;
    const q = supabase.from("orders")
      .select("id, customer_id, customer_name, order_number, total_amount, vat_amount, outstanding_amount, payment_method, created_at")
      .eq("biz_session_id", sid)
      .neq("status", "cancelled")
      .order("created_at");
    const { data } = cid ? await q.eq("customer_id", cid) : await q.is("customer_id", null);
    setCustomerRows(prev => prev.map(r =>
      r.customer_id === customerKey ? { ...r, orders: (data ?? []) as Order[], ordersLoaded: true } : r
    ));
  }

  // 진입 시: 활성 세션 우선, 없으면 가장 최근 세션
  async function loadInitialSession(tid: string) {
    setLoading(true);
    const activeId = getBizSessionId();
    let row: BizSession | null = null;
    if (activeId) {
      const { data } = await supabase.from("biz_sessions").select(BIZ_COLS).eq("id", activeId).single();
      row = data as BizSession | null;
    }
    if (!row) {
      const { data } = await supabase.from("biz_sessions").select(BIZ_COLS)
        .eq("tenant_id", tid).order("opened_at", { ascending: false }).limit(1).maybeSingle();
      row = data as BizSession | null;
    }
    setSession(row);
    if (row) setSelectedDate(toDateInputValue(row.opened_at));
    setLoading(false);
  }

  async function loadSessionByDate(tid: string, date: string) {
    setLoading(true);
    const start = `${date}T00:00:00`;
    const end = `${date}T23:59:59.999`;
    const { data } = await supabase.from("biz_sessions").select(BIZ_COLS)
      .eq("tenant_id", tid).gte("opened_at", start).lte("opened_at", end)
      .order("opened_at", { ascending: false }).limit(1).maybeSingle();
    setSession(data as BizSession | null);
    setLoading(false);
  }

  async function navigateSession(dir: "prev" | "next") {
    if (!tenantId || !session) return;
    setLoading(true);
    const q = supabase.from("biz_sessions").select(BIZ_COLS).eq("tenant_id", tenantId);
    const { data } = dir === "prev"
      ? await q.lt("opened_at", session.opened_at).order("opened_at", { ascending: false }).limit(1).maybeSingle()
      : await q.gt("opened_at", session.opened_at).order("opened_at", { ascending: true }).limit(1).maybeSingle();
    if (data) {
      const row = data as unknown as BizSession;
      setSession(row);
      setSelectedDate(toDateInputValue(row.opened_at));
    }
    setLoading(false);
  }

  // 시재 계산 (라이브든 캐시든 summary가 동일한 형태라 동작 동일)
  const cashCalc = useMemo(() => {
    if (!session || !summary) return null;
    const expected = (session.opening_cash || 0) + summary.cashIn.amount + summary.manualIn.amount - summary.manualOut.amount;
    const actual = session.status === "closed" ? (session.closing_cash ?? 0) : null;
    const diff = actual != null ? actual - expected : null;
    return { expected, actual, diff };
  }, [session, summary]);

  const isActive = session?.status === "open";

  // 활성 세션일 때 — 페이지 다시 보거나 창 포커스 받으면 자동 새로고침.
  // (정산완료 세션은 박제돼있어 갱신 불필요. polling X — 부하 0)
  useEffect(() => {
    if (!isActive || !tenantId || !session) return;
    function refresh() {
      if (document.visibilityState !== "visible") return;
      if (!session) return;
      if (isCached(session)) loadFromCache(session);
      else                   loadLive(session.id);
    }
    document.addEventListener("visibilitychange", refresh);
    window.addEventListener("focus", refresh);
    return () => {
      document.removeEventListener("visibilitychange", refresh);
      window.removeEventListener("focus", refresh);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isActive, tenantId, session?.id]);

  return (
    <div className={PAGE_ACTION_BAR_SPACER}>
      <PageHeader title="영업정산" />

      {/* 상단 컨트롤: 날짜 / 이전·다음 / 새로고침 / 세션 메타 */}
      <div className="flex items-center gap-3 mb-3 bg-white px-4 py-2.5 rounded-xl border border-gray-200">
        <span className="text-xs font-semibold text-gray-500">해당일자</span>
        <input
          type="date"
          value={selectedDate}
          onChange={e => {
            setSelectedDate(e.target.value);
            if (tenantId && e.target.value) loadSessionByDate(tenantId, e.target.value);
          }}
          className="input-sm"
        />
        <button onClick={() => navigateSession("prev")} disabled={!session || loading}
          className="px-2.5 py-1 text-xs border border-gray-300 rounded-lg hover:bg-gray-50 disabled:opacity-40">‹ 이전세션</button>
        <button onClick={() => navigateSession("next")} disabled={!session || loading}
          className="px-2.5 py-1 text-xs border border-gray-300 rounded-lg hover:bg-gray-50 disabled:opacity-40">다음세션 ›</button>

        <div className="flex-1" />

        {session && (
          <div className="flex items-center gap-3 text-xs text-gray-600">
            <Badge color={isActive ? "blue" : "orange"}>{isActive ? "영업 중" : "정산완료"}</Badge>
            <span>근무자: <strong className="text-gray-900">{session.opener_name}</strong>{session.closer_name ? ` → ${session.closer_name}` : ""}</span>
            <span>영업시간: {formatDuration(session.opened_at, session.closed_at)}</span>
          </div>
        )}

        <button
          onClick={() => {
            if (!tenantId) return;
            if (session) {
              if (isCached(session)) loadFromCache(session);
              else                   loadLive(session.id);
            } else {
              loadInitialSession(tenantId);
            }
          }}
          className="px-3 py-1.5 text-xs text-gray-600 border border-gray-300 rounded-lg hover:bg-gray-50"
        >새로고침</button>
      </div>

      {loading ? (
        <div className="bg-white rounded-xl border border-gray-200 p-16 text-center text-gray-300 text-sm">불러오는 중...</div>
      ) : !session ? (
        <div className="bg-white rounded-xl border border-gray-200 p-16 text-center text-gray-300 text-sm">
          세션이 없습니다. 상단의 [영업개시]를 눌러 시작해주세요.
        </div>
      ) : !summary ? (
        <div className="bg-white rounded-xl border border-gray-200 p-16 text-center text-gray-300 text-sm">집계 중...</div>
      ) : (
        <div className="grid grid-cols-[360px_1fr] gap-3">
          <div className="space-y-3">
            <SummaryPanel summary={summary} />
            <CashBox session={session} cashCalc={cashCalc} />
          </div>
          <CustomerSalesPanel
            rows={customerRows}
            cached={isCached(session)}
            onLazyLoadOrders={key => loadOrdersForCustomer(session.id, key)}
          />
        </div>
      )}

      {showOpenModal && tenantId && (
        <BizSessionOpenModal
          tenantId={tenantId}
          onClose={() => setShowOpenModal(false)}
          onSuccess={(bizSessionId, log) => {
            setShowOpenModal(false);
            bizOpen(bizSessionId);
            setSession(log as BizSession);
            setSelectedDate(toDateInputValue(log.opened_at));
          }}
        />
      )}

      {showSettleModal && tenantId && (
        <BusinessSettleModal
          onClose={() => setShowSettleModal(false)}
          onSuccess={log => {
            setShowSettleModal(false);
            bizClose();
            // RPC 결과는 새 컬럼 포함된 biz_sessions row 전체
            setSession(log as BizSession);
          }}
        />
      )}

      <PageActionBar>
        <Button onClick={() => setShowOpenModal(true)} disabled={isActive}>영업개시</Button>
        <button
          onClick={() => setShowSettleModal(true)}
          disabled={!isActive}
          className="px-4 py-2 bg-orange-500 text-white text-sm font-bold rounded-lg hover:bg-orange-600 disabled:opacity-40 disabled:cursor-not-allowed"
        >
          영업정산
        </button>
      </PageActionBar>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────────────
// 좌: 집계 패널
// ──────────────────────────────────────────────────────────────────────────────

const ROW_LABEL = "text-xs text-gray-600";
const ROW_COUNT = "text-xs text-gray-500 text-right tabular-nums";
const ROW_AMOUNT = "text-sm font-medium text-gray-900 text-right tabular-nums";

function Row({ label, count, amount, accent, bold }: {
  label: string; count?: number; amount?: number;
  accent?: "blue" | "red"; bold?: boolean;
}) {
  const cls = accent === "blue" ? "text-primary" : accent === "red" ? "text-red-500" : "";
  const labelCls = bold ? "text-xs font-bold text-gray-800" : ROW_LABEL;
  const amountCls = `${ROW_AMOUNT} ${cls} ${bold ? "font-bold text-base" : ""}`;
  return (
    <div className="grid grid-cols-[1fr_40px_120px] items-center px-3 py-1.5 border-b border-gray-100 last:border-0">
      <span className={labelCls}>{label}</span>
      <span className={ROW_COUNT}>{count ? count : ""}</span>
      <span className={amountCls}>{amount ? amount.toLocaleString() : ""}</span>
    </div>
  );
}

function SummaryPanel({ summary }: { summary: Summary }) {
  return (
    <div className="bg-white rounded-xl border border-gray-200">
      <div className="px-3 py-2 border-b border-gray-200 bg-gray-50 rounded-t-xl">
        <span className="text-xs font-bold text-gray-700">매출 / 입출금 집계</span>
      </div>
      <Row label="매출합계" count={summary.totalSales.count} amount={summary.totalSales.amount} bold />
      <Row label="판매계" count={summary.sales.count} amount={summary.sales.amount} />
      <Row label="반품계" count={summary.returns.count} amount={summary.returns.amount} accent="red" />
      <Row label="매입" count={summary.purchase.count} amount={summary.purchase.amount} />
      <Row label="현금입금" count={summary.cashIn.count} amount={summary.cashIn.amount} accent="blue" />
      <Row label="통장입금" count={summary.transferIn.count} amount={summary.transferIn.amount} />
      <Row label="외상" count={summary.credit.count} amount={summary.credit.amount} accent="red" />
      <Row label="입고계" count={summary.inbound.count} amount={summary.inbound.amount} />
      <Row label="별도입금" count={summary.manualIn.count} amount={summary.manualIn.amount} />
      <Row label="별도출금" count={summary.manualOut.count} amount={summary.manualOut.amount} />
      <Row label="부가세" count={summary.vat.count} amount={summary.vat.amount} />
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────────────
// 좌: 시재 박스
// ──────────────────────────────────────────────────────────────────────────────

function CashBox({ session, cashCalc }: {
  session: BizSession;
  cashCalc: { expected: number; actual: number | null; diff: number | null } | null;
}) {
  const isClosed = session.status === "closed";
  const diffAccent: "blue" | "red" | undefined = cashCalc?.diff == null
    ? undefined
    : cashCalc.diff === 0 ? undefined : cashCalc.diff > 0 ? "blue" : "red";

  return (
    <div className="bg-white rounded-xl border border-gray-200">
      <div className="px-3 py-2 border-b border-gray-200 bg-gray-50 rounded-t-xl">
        <span className="text-xs font-bold text-gray-700">시재</span>
      </div>
      <Row label="개시시재" amount={session.opening_cash || undefined} accent="red" />
      <Row label="전산현금 (예상)" amount={cashCalc?.expected || undefined} />
      <Row label="돈통현금 (실제)" amount={isClosed ? (session.closing_cash ?? undefined) : undefined} accent="red" />
      <Row label="현금과부족" amount={cashCalc?.diff ?? undefined} accent={diffAccent} bold />
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────────────
// 우: 거래처별 매출 (행 클릭 시 주문 펼침)
// ──────────────────────────────────────────────────────────────────────────────

function CustomerSalesPanel({ rows, cached, onLazyLoadOrders }: {
  rows: CustomerRow[];
  cached: boolean;
  onLazyLoadOrders: (customerKey: string) => Promise<void>;
}) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  function toggle(r: CustomerRow) {
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(r.customer_id)) {
        next.delete(r.customer_id);
      } else {
        next.add(r.customer_id);
        // cached 모드 + 미로딩이면 lazy fetch
        if (cached && !r.ordersLoaded) onLazyLoadOrders(r.customer_id);
      }
      return next;
    });
  }

  return (
    <DataTable maxHeight="calc(100vh - 220px)">
      <TableHead>
        <Th className="w-12">#</Th>
        <Th>판매처</Th>
        <Th className="text-right">판매금액</Th>
        <Th className="text-right">반품금액</Th>
        <Th className="text-right">매입</Th>
      </TableHead>
      <tbody>
        {rows.length === 0 ? (
          <EmptyRow colSpan={5} message="이 세션에 발생한 매출이 없습니다." />
        ) : rows.flatMap((r, idx) => {
          const isOpen = expanded.has(r.customer_id);
          const head = (
            <tr key={r.customer_id} className="border-b border-gray-100 hover:bg-gray-50 cursor-pointer"
                onClick={() => toggle(r)}>
              <td className="px-4 py-3 text-center text-xs text-gray-500">{idx + 1}</td>
              <td className="px-4 py-3 font-medium text-gray-800">
                <span className="inline-block w-3 text-gray-400">{isOpen ? "▾" : "▸"}</span>
                <span className="ml-1">{r.customer_name}</span>
                {r.ordersLoaded && <span className="ml-2 text-xs text-gray-400">({r.orders.length}건)</span>}
              </td>
              <td className="px-4 py-3 text-right tabular-nums">{r.sales ? r.sales.toLocaleString() : "-"}</td>
              <td className="px-4 py-3 text-right text-red-500 tabular-nums">{r.returns ? r.returns.toLocaleString() : "-"}</td>
              <td className="px-4 py-3 text-right tabular-nums">{r.purchase ? r.purchase.toLocaleString() : "-"}</td>
            </tr>
          );
          if (!isOpen) return [head];
          if (cached && !r.ordersLoaded) {
            return [head, (
              <tr key={`${r.customer_id}-loading`} className="bg-gray-50 border-b border-gray-100 text-xs">
                <td />
                <td colSpan={4} className="pl-10 py-2 text-gray-400">불러오는 중...</td>
              </tr>
            )];
          }
          const detail = r.orders.map(o => (
            <tr key={o.id} className="bg-gray-50 border-b border-gray-100 text-xs">
              <td />
              <td className="pl-10 py-2 text-gray-500">
                <span className="text-gray-400">{o.order_number ?? "-"}</span>
                <span className="ml-2">
                  {o.payment_method === "cash" && <Badge color="green">현금</Badge>}
                  {o.payment_method === "transfer" && <Badge color="blue">통장</Badge>}
                  {o.payment_method === "credit" && <Badge color="purple">외상</Badge>}
                </span>
              </td>
              <td className="px-4 py-2 text-right tabular-nums text-gray-700">{o.total_amount.toLocaleString()}</td>
              <td />
              <td />
            </tr>
          ));
          return [head, ...detail];
        })}
      </tbody>
    </DataTable>
  );
}
