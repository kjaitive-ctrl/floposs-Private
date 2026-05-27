"use client";

import { useState, useEffect, useCallback, useMemo, useRef, Suspense, Fragment } from "react";
import { useTenant } from "@/lib/useTenant";
import { useRouter, useSearchParams } from "next/navigation";
import { supabase } from "@/lib/supabase";
import { krw, formatOrderTime, METHOD_LABELS, displayOutstanding, formatKstDateOnly } from "@/lib/format";
import { DataTable, TableHead, Th, Badge, EmptyRow, LoadingRow, PageHeader, INPUT_SM } from "../_components/DataTable";
import SamplesView from "./_SamplesView";
import SaleForm, { type SavedOrder } from "../_components/SaleForm";
import { ensureBizOpen } from "@/lib/bizSession";
import CustomerPaymentForm from "../_components/CustomerPaymentForm";
import { ReceiptPrintModal } from "../_components/receipt/ReceiptPrintModal";
import { ReceiptInlinePanel } from "../_components/receipt/ReceiptInlinePanel";
import { PendingPrintModal, type PendingMode } from "../_components/receipt/PendingPrintModal";
import Button from "../_components/Button";

const METHOD_COLORS = {
  cash:     { on: "bg-cash text-white border-cash",         off: "bg-white text-gray-900 border-gray-300 hover:bg-cash-soft" },
  transfer: { on: "bg-transfer text-white border-transfer", off: "bg-white text-gray-900 border-gray-300 hover:bg-transfer-soft" },
  credit:   { on: "bg-credit text-white border-credit",     off: "bg-white text-gray-900 border-gray-300 hover:bg-credit-soft" },
};

const PROCESS_TYPE_LABEL: Record<string, string> = {
  ordered:   "미처리",
  backorder: "미송",
  hold:      "보류",
};

// ★ 처리 종류 뱃지 — 모든 화면에서 동일 css 사용
type ProcessBadgeKind = "출고" | "미송" | "보류" | "샘플" | "샘결" | "교환" | "외";
const PROCESS_BADGE_STYLES: Record<ProcessBadgeKind, string> = {
  출고: "bg-primary-soft text-primary border-primary-border",
  미송: "bg-orange-100 text-orange-600 border-orange-200",
  보류: "bg-yellow-100 text-yellow-600 border-yellow-200",
  샘플: "bg-amber-100 text-amber-700 border-amber-200",
  샘결: "bg-primary-soft-hover text-primary-hover border-primary-border",
  교환: "bg-emerald-100 text-emerald-600 border-emerald-200",
  외:   "bg-sky-100 text-sky-700 border-sky-200",
};
function ProcessBadge({ kind }: { kind: ProcessBadgeKind }) {
  return (
    <span className={`shrink-0 px-1 py-0 text-[10px] font-semibold rounded border ${PROCESS_BADGE_STYLES[kind]}`}>
      {kind}
    </span>
  );
}

function shipStatus(status: string, shippedQty: number, quantity: number) {
  if (status !== "shipped") return "active";
  if (shippedQty === 0) return "released";
  if (shippedQty < quantity) return "partial";
  return "shipped";
}

type Order = {
  id: string;
  order_number: string;
  created_at: string;
  receipt_issued_at?: string | null;
  total_amount: number;
  vat_amount: number;
  order_qty: number;
  sales_qty: number;
  revenue: number;
  confirmed_amount: number;
  is_processed: boolean;
  customer_name: string | null;
  payment_method: string;
  customer_id: string;
  payment_status: string;
  outstanding_amount: number;
  has_pending: boolean;
  is_sample?: boolean;
  order_source?: string;
  // 영수증 뱃지 분류 (한 영수증에 여러 종류 가능)
  has_shipped?: boolean;
  has_backorder?: boolean;
  has_hold?: boolean;
  // 확정 수량 (출고 + 미송잔량 + 보류잔량) — 영수증 표시용
  confirmed_qty?: number;
  // 영업세션 (세션 경계 시각화 + 필터 기준)
  biz_session_id?: string | null;
};

type OrderItem = {
  id: string;
  variant_id: string;
  quantity: number;
  shipped_qty: number;
  remaining_qty?: number;
  unit_price: number;
  total_price: number;
  process_type: string;
  status: string;
  is_exchange?: boolean;
  is_sample?: boolean;
  product_variants: { color: string; size: string; products: { name: string } | null } | null;
  // 누적 반품/교환량 (inventory_logs SUM) — fetchOrderItems 가 채움.
  // 반품 가능 잔량 = shipped_qty - returned_qty
  returned_qty?: number;
};

type FlatItem = {
  id: string;
  order_id: string;
  customer_id: string;
  payment_status: string;
  order_number: string;
  order_source: string | null;
  created_at: string;
  item_created_at: string;
  company_name: string;
  product_name: string;
  color: string;
  size: string;
  variant_id: string;
  product_id: string | null;  // 미발송(상품) 모달용 — variant.product_id
  quantity: number;
  shipped_qty: number;
  remaining_qty: number;
  unit_price: number;
  total_price: number;
  process_type: string;
  status: string;
  is_exchange: boolean;
  is_sample: boolean;
};

type Tab = "sale" | "receipt";
type SampleFilter = "all" | "order" | "sample";

// 영업세션 (필터/페이지네이션용). closed 면 stats 박제, active 면 null.
type BizSession = {
  id: string;
  opened_at: string;
  status: string;
  sales_count: number | null;
  sales_amount: number | null;
};

// receipt 탭 페이지네이션 — 사장 결정 2026-05-18: 300개/페이지, 페이지 안에서 세션 경계 시각화.
const RECEIPT_PAGE_SIZE = 300;
// 영업세션 dropdown 옵션 최대 — 사장 결정: 최근 한 달 ≈ 30 세션.
const SESSION_OPTIONS_LIMIT = 30;

type RawOrder = {
  id: string;
  customer_id?: string | null;
  customer_name?: string | null;
  payment_status?: string | null;
  order_number?: string | null;
  order_source?: string | null;
  created_at?: string | null;
};
type RawItem = {
  id: string;
  variant_id: string;
  quantity: number;
  shipped_qty?: number | null;
  remaining_qty?: number | null;
  unit_price: number;
  total_price: number;
  process_type: string;
  status: string;
  is_exchange?: boolean | null;
  is_sample?: boolean | null;
  created_at?: string | null;
  product_variants?: {
    color?: string | null;
    size?: string | null;
    product_id?: string | null;
    products?: { name?: string | null } | null;
  } | null;
};
type RawOrderWithItems = RawOrder & { order_items?: RawItem[] | null };

function mapToFlatItem(o: RawOrder, item: RawItem): FlatItem {
  return {
    id: item.id,
    order_id: o.id,
    customer_id: o.customer_id ?? "",
    product_id: item.product_variants?.product_id ?? null,
    payment_status: o.payment_status ?? "unpaid",
    order_number: o.order_number ?? "-",
    order_source: o.order_source ?? null,
    created_at: o.created_at ?? "",
    item_created_at: item.created_at ?? "",
    company_name: o.customer_name ?? "-",
    product_name: item.product_variants?.products?.name ?? "-",
    color: item.product_variants?.color ?? "-",
    size: item.product_variants?.size ?? "-",
    variant_id: item.variant_id,
    quantity: item.quantity,
    shipped_qty: item.shipped_qty ?? 0,
    remaining_qty: item.remaining_qty ?? item.quantity,
    unit_price: item.unit_price,
    total_price: item.total_price,
    process_type: item.process_type,
    status: item.status,
    is_exchange: item.is_exchange ?? false,
    is_sample: item.is_sample ?? false,
  };
}

function OrdersPageInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const tab = (searchParams.get("tab") as Tab) ?? "sale";
  const orderParam = searchParams.get("order") ?? "";
  const refresh = searchParams.get("refresh");

  const tenant = useTenant();
  const tenantId = tenant?.id ?? null;
  const tenantCode = tenant?.tenantCode ?? "";

  // 영수증 기준
  const [orders, setOrders] = useState<Order[]>([]);
  const [selectedOrderId, setSelectedOrderId] = useState<string | null>(null);
  const [orderItems, setOrderItems] = useState<OrderItem[]>([]);
  const [loadingOrders, setLoadingOrders] = useState(false);
  const [loadingItems, setLoadingItems] = useState(false);
  const [customerBalances, setCustomerBalances] = useState<Record<string, number>>({});
  const [customerPaymentMethods, setCustomerPaymentMethods] = useState<Record<string, string>>({});
  const [customerIncludeVat, setCustomerIncludeVat] = useState<Record<string, boolean>>({});
  const [dayProcessing, setDayProcessing] = useState<string | null>(null);
  const [paymentForm, setPaymentForm] = useState<{
    customerId: string;
    customerInput: string;
    processing: boolean;
  } | null>(null);

  // receipt 탭 필터/페이지네이션 — 영업세션 다중선택 + 거래처 검색 + 300/페이지.
  // 사장 결정 2026-05-18 (B1): 영업개시 전이면 default = 최근 정산완료 세션 1개 자동 선택 (Phase 4).
  const [bizSessions, setBizSessions] = useState<BizSession[]>([]);
  const [selectedSessionIds, setSelectedSessionIds] = useState<string[]>([]);
  const [customerSearch, setCustomerSearch] = useState("");
  const [pageOffset, setPageOffset] = useState(0);
  const [totalCount, setTotalCount] = useState(0);
  // 영업세션 dropdown 펼침 state + outside click 닫기
  const [sessionDropdownOpen, setSessionDropdownOpen] = useState(false);
  const sessionDropdownRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    function onClick(e: MouseEvent) {
      if (sessionDropdownRef.current && !sessionDropdownRef.current.contains(e.target as Node)) {
        setSessionDropdownOpen(false);
      }
    }
    if (sessionDropdownOpen) document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [sessionDropdownOpen]);

  // 빈 상태 자동 default 선택 — 사장 결정 2026-05-18 (개정): default = 최근 7개 세션 (≈ 이번주).
  // "활성 세션 1개만" 보고 싶으면 빠른 선택 [활성] 클릭. 사장이 한 번이라도 선택하면 자동 X.
  const autoSelectedRef = useRef(false);
  useEffect(() => {
    if (autoSelectedRef.current) return;
    if (bizSessions.length === 0) return;
    if (selectedSessionIds.length > 0) {
      autoSelectedRef.current = true;
      return;
    }
    const defaultIds = bizSessions.slice(0, 7).map(s => s.id);
    if (defaultIds.length > 0) {
      setSelectedSessionIds(defaultIds);
      autoSelectedRef.current = true;
    }
  }, [bizSessions, selectedSessionIds]);

  // 상품 기준
  const [flatItems, setFlatItems] = useState<FlatItem[]>([]);
  const [loadingFlat, setLoadingFlat] = useState(false);
  const [inventoryMap, setInventoryMap] = useState<Record<string, number>>({});
  const [qtyInputs, setQtyInputs] = useState<Record<string, string>>({});
  const [filterOrder, setFilterOrder] = useState(orderParam);
  const [filterCustomer, setFilterCustomer] = useState("");
  const [filterProduct, setFilterProduct] = useState("");
  const [processing, setProcessing] = useState(false);
  const [errorIds, setErrorIds] = useState<Set<string>>(new Set());
  // 토글 state — 탭별 분리 (당일/미송보류 각자 독립). sample 탭은 SamplesView 자체 사용.
  const [shipIdsToday, setShipIdsToday]           = useState<Set<string>>(new Set());
  const [shipIdsPending, setShipIdsPending]       = useState<Set<string>>(new Set());
  const [backorderIdsToday, setBackorderIdsToday] = useState<Set<string>>(new Set());
  const [backorderIdsPending, setBackorderIdsPending] = useState<Set<string>>(new Set());
  const [holdIdsToday, setHoldIdsToday]           = useState<Set<string>>(new Set());
  const [holdIdsPending, setHoldIdsPending]       = useState<Set<string>>(new Set());
  const [releaseIdsToday, setReleaseIdsToday]     = useState<Set<string>>(new Set());
  const [releaseIdsPending, setReleaseIdsPending] = useState<Set<string>>(new Set());
  const [deleteIdsToday, setDeleteIdsToday]       = useState<Set<string>>(new Set());
  const [deleteIdsPending, setDeleteIdsPending]   = useState<Set<string>>(new Set());
  const inputRefs = useRef<Map<string, HTMLInputElement>>(new Map());

  // 샘플 필터 (영수증/상품 탭 공통)
  const [sampleFilter, setSampleFilter] = useState<SampleFilter>("all");
  // 상품 기준 탭 정렬: 일시순(default) / 거래처순 (거래처 모아서 미송/보류 명세서 출력 시 활용)
  const [productSort, setProductSort] = useState<"time" | "customer">("time");

  const [receiptModal, setReceiptModal] = useState<
    | { kind: "order";  orderId: string }
    | null
  >(null);
  // 상품기준 탭 — 단일 행 선택 (라디오). 미발송 모달 호출 시 선택 행의 거래처/상품 사용.
  const [selectedFlatItemId, setSelectedFlatItemId] = useState<string | null>(null);
  const [pendingModal, setPendingModal] = useState<PendingMode | null>(null);

  // 영수증 기준 탭 — 주문 상세 패널의 교환/반품 액션 (history 패턴과 동일, state 만 분리)
  const [detailExchangeIds, setDetailExchangeIds] = useState<Set<string>>(new Set());
  const [detailReturnIds, setDetailReturnIds]     = useState<Set<string>>(new Set());
  const [detailQtyInputs, setDetailQtyInputs]     = useState<Record<string, string>>({});
  const [detailErrorIds, setDetailErrorIds]       = useState<Set<string>>(new Set());
  const [detailProcessing, setDetailProcessing]   = useState(false);

  // 주문처리 탭 — 당일(현금/통장/청구) 출고 시 결제수단 선택 분리 (탭별)
  const [shipPaymentMapToday, setShipPaymentMapToday]     = useState<Record<string, "cash" | "transfer" | "credit">>({});
  const [shipPaymentMapPending, setShipPaymentMapPending] = useState<Record<string, "cash" | "transfer" | "credit">>({});

  // 영업세션 id → 라벨 (개시 KST 날짜 + 상태 + 매출 미니) — 세션 경계 row 표시용.
  const sessionInfoMap = useMemo(() => {
    const m: Record<string, BizSession> = {};
    bizSessions.forEach(s => { m[s.id] = s; });
    return m;
  }, [bizSessions]);

  // productPanel 내부 탭 — 당일 / 미송·보류 / 샘플
  const [posTab, setPosTab] = useState<"today" | "pending" | "sample">("today");

  // 현재 탭(today/pending) alias — sample 탭에서는 today 측 reference 사용 (SamplesView 자체 state 라 무관)
  const isPending = posTab === "pending";
  const shipIds          = isPending ? shipIdsPending          : shipIdsToday;
  const setShipIds       = isPending ? setShipIdsPending       : setShipIdsToday;
  const backorderIds     = isPending ? backorderIdsPending     : backorderIdsToday;
  const setBackorderIds  = isPending ? setBackorderIdsPending  : setBackorderIdsToday;
  const holdIds          = isPending ? holdIdsPending          : holdIdsToday;
  const setHoldIds       = isPending ? setHoldIdsPending       : setHoldIdsToday;
  const releaseIds       = isPending ? releaseIdsPending       : releaseIdsToday;
  const setReleaseIds    = isPending ? setReleaseIdsPending    : setReleaseIdsToday;
  const deleteIds        = isPending ? deleteIdsPending        : deleteIdsToday;
  const setDeleteIds     = isPending ? setDeleteIdsPending     : setDeleteIdsToday;
  const shipPaymentMap   = isPending ? shipPaymentMapPending   : shipPaymentMapToday;
  const setShipPaymentMap = isPending ? setShipPaymentMapPending : setShipPaymentMapToday;
  // 샘플 탭의 [처리!] 버튼을 하단 띠로 portal 하기 위한 element ref
  const [sampleActionBarEl, setSampleActionBarEl] = useState<HTMLDivElement | null>(null);

  // 토글 헬퍼
  function del(set: React.Dispatch<React.SetStateAction<Set<string>>>, id: string) {
    set(prev => { const s = new Set(prev); s.delete(id); return s; });
  }
  function tog(set: React.Dispatch<React.SetStateAction<Set<string>>>, id: string) {
    set(prev => {
      const s = new Set(prev);
      if (s.has(id)) s.delete(id);
      else s.add(id);
      return s;
    });
  }
  function toggleShip(id: string) {
    [setHoldIds, setReleaseIds, setDeleteIds].forEach(s => del(s, id));
    tog(setShipIds, id);
  }
  // 결제수단별 당일 출고 — 같은 method 재클릭 시 해제, 다른 method 클릭 시 교체.
  // shipIds 와 동기화 (handleProcess 가 shipIds 만 봄). shipPaymentMap 은 분리 표시용.
  function setShipPayment(id: string, method: "cash" | "transfer" | "credit") {
    [setHoldIds, setReleaseIds, setDeleteIds].forEach(s => del(s, id));
    setShipPaymentMap(prev => {
      const next = { ...prev };
      if (next[id] === method) {
        delete next[id];
        setShipIds(s => { const ns = new Set(s); ns.delete(id); return ns; });
      } else {
        next[id] = method;
        setShipIds(s => new Set(s).add(id));
      }
      return next;
    });
  }
  function toggleBackorder(id: string) {
    [setHoldIds, setReleaseIds, setDeleteIds].forEach(s => del(s, id));
    tog(setBackorderIds, id);
  }
  function toggleHold(id: string) {
    [setShipIds, setBackorderIds, setReleaseIds, setDeleteIds].forEach(s => del(s, id));
    tog(setHoldIds, id);
  }
  function toggleRelease(id: string) {
    [setShipIds, setBackorderIds, setHoldIds, setDeleteIds].forEach(s => del(s, id));
    tog(setReleaseIds, id);
  }
  function toggleDelete(id: string) {
    [setShipIds, setBackorderIds, setHoldIds, setReleaseIds].forEach(s => del(s, id));
    tog(setDeleteIds, id);
  }
  function clearToggles() {
    [setShipIds, setBackorderIds, setHoldIds, setReleaseIds, setDeleteIds].forEach(s => s(new Set()));
    setShipPaymentMap({});
  }

  useEffect(() => { setFilterOrder(orderParam); }, [orderParam]);

  // 영업세션 dropdown 옵션 fetch — 최근 SESSION_OPTIONS_LIMIT 개 (active + closed).
  // closed 세션의 stats 컬럼은 074~077 마이그가 박제. active 는 null.
  const fetchBizSessions = useCallback(async (tid: string) => {
    const { data } = await supabase
      .from("biz_sessions")
      .select("id, opened_at, status, sales_count, sales_amount")
      .eq("tenant_id", tid)
      .in("status", ["active", "closed"])
      .order("opened_at", { ascending: false })
      .limit(SESSION_OPTIONS_LIMIT);
    setBizSessions((data ?? []) as BizSession[]);
  }, []);

  // orders + customers 단일 쿼리
  const fetchOrders = useCallback(async (tid: string) => {
    setLoadingOrders(true);
    // Phase 7-1: 영수증 박제된 주문만 노출 (미처리 = receipt_no NULL → 주문등록 탭 전용)
    // 필터: 거래처 검색 + 영업세션 다중선택. 페이지네이션: 300/페이지.
    let query = supabase
      .from("orders")
      .select(`
        id, order_number, created_at, receipt_issued_at, total_amount, vat_amount, order_qty, sales_qty, revenue, confirmed_amount,
        is_processed, has_pending, customer_name, payment_method, customer_id, payment_status, outstanding_amount,
        order_source, biz_session_id,
        customers(outstanding_balance, outstanding_vat, default_payment_method, include_vat),
        order_items(is_sample, process_type, status, shipped_qty, remaining_qty, quantity)
      `, { count: "exact" })
      .eq("tenant_id", tid)
      .not("receipt_no", "is", null);

    if (customerSearch.trim()) {
      query = query.ilike("customer_name", `%${customerSearch.trim()}%`);
    }
    if (selectedSessionIds.length > 0) {
      query = query.in("biz_session_id", selectedSessionIds);
    }

    const { data, count } = await query
      // 영수증 발행 시각(처리 시점) 내림차순. 등록 순서가 아니라 처리 순서로 표시.
      .order("receipt_issued_at", { ascending: false, nullsFirst: false })
      .range(pageOffset, pageOffset + RECEIPT_PAGE_SIZE - 1);
    setTotalCount(count ?? 0);

    type ItemMeta = { is_sample?: boolean; process_type?: string; status?: string; shipped_qty?: number; remaining_qty?: number; quantity?: number };
    type RowWithJoins = Order & {
      customers?: { outstanding_balance?: number; outstanding_vat?: number; default_payment_method?: string; include_vat?: boolean } | null;
      order_items?: ItemMeta[] | null;
    };
    const rows = (data ?? []) as RowWithJoins[];
    const balMap: Record<string, number> = {};
    const pmMap: Record<string, string> = {};
    const vatMap: Record<string, boolean> = {};
    const orders: Order[] = rows.map(r => {
      if (r.customer_id && r.customers) {
        balMap[r.customer_id] = displayOutstanding(r.customers);
        pmMap[r.customer_id] = r.customers.default_payment_method ?? "cash";
        vatMap[r.customer_id] = r.customers.include_vat ?? false;
      }
      const items = r.order_items ?? [];
      const isSample = items.length > 0 && items.every(i => i.is_sample);
      // 처리 종류 뱃지 분류 (한 영수증에 여러 종류 동시 가능)
      const hasShipped   = items.some(i => !i.is_sample && (i.shipped_qty ?? 0) > 0);
      const hasBackorder = items.some(i => i.process_type === "backorder" && i.status === "unshipped");
      const hasHold      = items.some(i => i.process_type === "hold"      && i.status === "unshipped");
      // 영수증 표시 수량 (출고 + 미송/보류 잔량 + 샘플 임대 단위) — 영수증 양식 본문과 일관.
      // 음수 표시:
      //   - 반품 derived (order_source='return')
      //   - 미송해제 derived (order_source='backorder_release', 148 마이그)
      // 샘플 라인은 quantity 직접 사용 (영수증 route 의 sample 분기와 동일).
      const isNegative = r.order_source === "return" || r.order_source === "backorder_release";
      const rawConfirmedQty = items.reduce((sum, i) => {
        // 박제 freeze: 미송 row 의 quantity 는 immutable (process_pending_ship/release 로
        //   shipped_qty/remaining_qty 만 변동). 부모 영수증 confirmed_qty 는 박제값 보존.
        const isBackorderRow = i.process_type === "backorder";
        const shipped = (!i.is_sample && !isBackorderRow) ? (i.shipped_qty ?? 0) : 0;
        const samplePart = i.is_sample && i.process_type === "ordered" ? (i.quantity ?? 0) : 0;
        // 매트릭스: 보류 = 0 (영수증 박제 X). 미송 row = quantity 박제값.
        const backorderPart = isBackorderRow ? (i.quantity ?? 0) : 0;
        return sum + shipped + samplePart + backorderPart;
      }, 0);
      const confirmedQty = isNegative ? -rawConfirmedQty : rawConfirmedQty;
      const { customers: _, order_items: __, ...order } = r;
      return { ...order, is_sample: isSample, has_shipped: hasShipped, has_backorder: hasBackorder, has_hold: hasHold, confirmed_qty: confirmedQty } as Order;
    });
    // pageOffset > 0 = "더보기" 클릭 결과 → append. 0 = 필터 변경/최초 = replace.
    // 필터 onChange 시 setPageOffset(0) 호출 → 다음 fetch 는 replace.
    const isAppend = pageOffset > 0;
    setOrders(prev => isAppend ? [...prev, ...orders] : orders);
    setCustomerBalances(prev => isAppend ? { ...prev, ...balMap } : balMap);
    setCustomerPaymentMethods(prev => isAppend ? { ...prev, ...pmMap } : pmMap);
    setCustomerIncludeVat(prev => isAppend ? { ...prev, ...vatMap } : vatMap);
    setLoadingOrders(false);
  }, [customerSearch, selectedSessionIds, pageOffset]);

  const fetchFlatItems = useCallback(async (tid: string) => {
    setLoadingFlat(true);
    const { data, error } = await supabase
      .from("orders")
      .select(`
        id, order_number, created_at, customer_name, customer_id, payment_status, order_source,
        customers(default_payment_method),
        order_items(
          id, created_at, variant_id, quantity, shipped_qty, remaining_qty, unit_price, total_price, process_type, status, is_exchange, is_sample,
          product_variants(color, size, product_id, products(name))
        )
      `)
      .eq("tenant_id", tid)
      .order("created_at", { ascending: false })
      .limit(200);

    if (error) { setLoadingFlat(false); return; }

    type RawOrderWithJoins = RawOrderWithItems & { customers?: { default_payment_method?: string } | null };
    const rawRows = (data ?? []) as RawOrderWithJoins[];

    const pmMap: Record<string, string> = {};
    rawRows.forEach(o => {
      if (o.customer_id && o.customers?.default_payment_method) {
        pmMap[o.customer_id] = o.customers.default_payment_method;
      }
    });
    if (Object.keys(pmMap).length > 0) {
      setCustomerPaymentMethods(prev => ({ ...prev, ...pmMap }));
    }

    const rows: FlatItem[] = rawRows.flatMap(o =>
      (o.order_items ?? []).map(item => mapToFlatItem(o, item))
    );
    setFlatItems(prev => {
      if (prev.length === 0) {
        return [...rows].sort((a, b) => {
          const d = new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
          return d !== 0 ? d : new Date(a.item_created_at).getTime() - new Date(b.item_created_at).getTime();
        });
      }
      const prevIds = prev.map(i => i.id);
      const newById = new Map(rows.map(r => [r.id, r]));
      const merged = prevIds.filter(id => newById.has(id)).map(id => newById.get(id)!);
      const newRows = rows.filter(r => !prevIds.includes(r.id));
      for (const nr of newRows) {
        const lastIdx = merged.map((m, i) => m.order_id === nr.order_id ? i : -1).filter(i => i >= 0).pop();
        if (lastIdx !== undefined) {
          // 같은 주문에 추가된 item — 그 주문의 마지막 다음에 (item.created_at 오름차순 유지)
          merged.splice(lastIdx + 1, 0, nr);
        } else {
          // 새 주문 (예: 샘결 → 새 order) — order.created_at 내림차순 위치에 삽입.
          // (push 면 항상 끝으로 가서 영수증 기준 탭과 정렬이 어긋남)
          const t = new Date(nr.created_at).getTime();
          const insertAt = merged.findIndex(m => new Date(m.created_at).getTime() < t);
          if (insertAt === -1) merged.push(nr);
          else merged.splice(insertAt, 0, nr);
        }
      }
      return merged;
    });
    const qtyMap: Record<string, string> = {};
    rows.forEach(r => { qtyMap[r.id] = r.remaining_qty.toLocaleString(); });
    setQtyInputs(qtyMap);

    const variantIds = [...new Set(rows.map(r => r.variant_id).filter(Boolean))];
    if (variantIds.length > 0) {
      const { data: invData } = await supabase
        .from("inventory")
        .select("variant_id, quantity")
        .eq("tenant_id", tid)
        .in("variant_id", variantIds);
      const map: Record<string, number> = {};
      (invData ?? []).forEach(r => { map[r.variant_id] = r.quantity; });
      setInventoryMap(map);
    }
    setLoadingFlat(false);
  }, []);

  useEffect(() => {
    if (!tenantId) return;
    if (tab === "receipt") {
      fetchBizSessions(tenantId);
      fetchOrders(tenantId);
    }
    if (tab === "sale") fetchFlatItems(tenantId);
  }, [tenantId, tab, refresh, fetchOrders, fetchBizSessions, fetchFlatItems]);

  async function fetchOrderItems(orderId: string) {
    setLoadingItems(true);
    const { data, error } = await supabase
      .from("order_items")
      .select(`id, variant_id, quantity, shipped_qty, remaining_qty, unit_price, total_price, process_type, status, is_exchange, is_sample,
        product_variants(color, size, products(name))`)
      .eq("order_id", orderId);
    if (error) { setLoadingItems(false); return; }
    const items = (data as unknown as OrderItem[]) ?? [];

    // 라인별 누적 반품/교환량 — inventory_logs(reason='return'/'exchange') SUM
    const itemIds = items.map(i => i.id);
    if (itemIds.length > 0) {
      const { data: logs } = await supabase
        .from("inventory_logs")
        .select("order_item_id, qty_change")
        .in("order_item_id", itemIds)
        .in("reason", ["return", "exchange"]);
      const returnedMap: Record<string, number> = {};
      (logs ?? []).forEach((r: { order_item_id: string; qty_change: number }) => {
        returnedMap[r.order_item_id] = (returnedMap[r.order_item_id] ?? 0) + (r.qty_change ?? 0);
      });
      items.forEach(i => { i.returned_qty = returnedMap[i.id] ?? 0; });
    }

    setOrderItems(items);
    setLoadingItems(false);
  }

  function selectOrder(order: Order) {
    setSelectedOrderId(order.id);
    fetchOrderItems(order.id);
    setDetailExchangeIds(new Set());
    setDetailReturnIds(new Set());
    setDetailQtyInputs({});
    setDetailErrorIds(new Set());
  }

  // 영수증 기준 탭 주문 상세 — 교환/반품 처리.
  // 사장 정책 (2026-05-06): 원 주문 박제 보존. 음수 derived 주문 + 영수증 발행 (마이그 140).
  // 교환도 일단 반품 영수증만 생성 (이후 새 출고 흐름은 별도 결정).
  async function handleDetailProcess() {
    if (!tenantId || detailProcessing || !selectedOrder) return;
    const allToggled = new Set([...detailExchangeIds, ...detailReturnIds]);
    if (allToggled.size === 0) return;
    if (!ensureBizOpen()) return;

    const newErrors = new Set<string>();
    for (const item of orderItems) {
      if (!allToggled.has(item.id)) continue;
      const qty = parseInt((detailQtyInputs[item.id] ?? "").replace(/,/g, ""), 10) || 0;
      const remainable = (item.shipped_qty ?? 0) - (item.returned_qty ?? 0);
      if (qty <= 0 || qty > remainable) newErrors.add(item.id);
    }
    if (newErrors.size > 0) { setDetailErrorIds(newErrors); return; }
    setDetailErrorIds(new Set());
    setDetailProcessing(true);

    // 교환/반품 분리 — reason 별로 하나씩 RPC 호출 (각자 별개 derived 주문)
    const buildItems = (toggleSet: Set<string>) =>
      orderItems
        .filter(i => toggleSet.has(i.id))
        .map(i => ({
          item_id: i.id,
          qty: parseInt((detailQtyInputs[i.id] ?? "").replace(/,/g, ""), 10) || 0,
        }))
        .filter(x => x.qty > 0);

    const exchangeItems = buildItems(detailExchangeIds);
    const returnItems   = buildItems(detailReturnIds);

    if (exchangeItems.length > 0) {
      const { error } = await supabase.rpc("process_return_derived", {
        p_tenant_id: tenantId,
        p_order_id:  selectedOrder.id,
        p_items:     exchangeItems,
        p_reason:    "exchange",
      });
      if (error) { alert("교환 오류: " + error.message); setDetailProcessing(false); return; }
    }
    if (returnItems.length > 0) {
      const { error } = await supabase.rpc("process_return_derived", {
        p_tenant_id: tenantId,
        p_order_id:  selectedOrder.id,
        p_items:     returnItems,
        p_reason:    "return",
      });
      if (error) { alert("반품 오류: " + error.message); setDetailProcessing(false); return; }
    }

    setDetailExchangeIds(new Set());
    setDetailReturnIds(new Set());
    setDetailQtyInputs({});
    setDetailProcessing(false);
    fetchOrderItems(selectedOrder.id);
    fetchOrders(tenantId);
  }

  function setTab(t: Tab) {
    router.replace(`/dashboard/orders-test?tab=${t}`);
  }

  // 탭 단축키 1~5 (input focus 시 비활성)
  useEffect(() => {
    const TAB_KEYS: Record<string, Tab> = {
      "1": "sale",
      "2": "receipt",
    };
    function handleKey(e: KeyboardEvent) {
      if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable)) return;
      const next = TAB_KEYS[e.key];
      if (next) {
        e.preventDefault();
        setTab(next);
      }
    }
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleDayPayment(order: Order, method: "cash" | "transfer") {
    if (!tenantId || order.outstanding_amount <= 0 || dayProcessing) return;
    if (!ensureBizOpen()) return;
    setDayProcessing(order.id);
    // 089 process_payment 호출로 통일 (vat 분리 정합 — 단순 결제는 vat=0)
    const { error } = await supabase.rpc("process_payment", {
      p_tenant_id:   tenantId,
      p_customer_id: order.customer_id,
      p_amount:      order.outstanding_amount,
      p_method:      method,
      p_source:      "payment",
      p_order_id:    order.id,
      p_vat_mode:    "none",
      p_vat_amount:  0,
    });
    setDayProcessing(null);
    if (error) { alert("처리 오류: " + error.message); return; }
    fetchOrders(tenantId);
  }

async function handlePurchaseCredit(order: Order) {
    if (!tenantId || dayProcessing) return;
    if (!ensureBizOpen()) return;
    setDayProcessing(order.id);
    const { error } = await supabase.rpc("apply_purchase_credit", {
      p_tenant_id:   tenantId,
      p_customer_id: order.customer_id,
      p_order_id:    order.id,
    });
    setDayProcessing(null);
    if (error) { alert("매입 처리 오류: " + error.message); return; }
    fetchOrders(tenantId);
  }

  async function handleCreditPayment(
    customerId: string,
    data: { amount: number; vatOn: boolean; vatAmount: number },
  ) {
    if (!tenantId) return;
    if (!ensureBizOpen()) return;
    // 더블 클릭 방지 — async setState 전 동기 가드 (race condition 차단).
    if (paymentForm?.processing) return;
    setPaymentForm(prev => prev ? { ...prev, processing: true } : null);

    const isRefund = data.amount < 0;
    const pm = customerPaymentMethods[customerId] ?? "transfer";
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
    fetchOrders(tenantId);
  }

  async function handleProcess() {
    if (!tenantId || processing) return;
    const allToggled = new Set([...shipIds, ...backorderIds, ...holdIds, ...releaseIds, ...deleteIds]);
    if (allToggled.size === 0) return;
    if (!ensureBizOpen()) return;

    // 재고 검증 (출고 토글된 row 의 같은 variant 합계 vs 현 재고)
    const newErrors = new Set<string>();
    const shipQtyByVariant = new Map<string, number>();
    for (const item of filteredItems) {
      if (!shipIds.has(item.id)) continue;
      const qty = parseInt((qtyInputs[item.id] ?? "").replace(/,/g, ""), 10) || 0;
      if (item.process_type === "backorder" && qty > item.remaining_qty) newErrors.add(item.id);
      if (qty > 0) shipQtyByVariant.set(item.variant_id, (shipQtyByVariant.get(item.variant_id) ?? 0) + qty);
    }
    for (const item of filteredItems) {
      if (!shipIds.has(item.id)) continue;
      const need  = shipQtyByVariant.get(item.variant_id) ?? 0;
      const stock = inventoryMap[item.variant_id] ?? 0;
      if (need > 0 && need > stock) newErrors.add(item.id);
    }
    if (newErrors.size > 0) {
      setErrorIds(newErrors);
      alert("재고가 부족한 항목이 있어 출고할 수 없습니다.\n수량을 조정하거나 [미송] 으로 처리해주세요.");
      return;
    }
    setErrorIds(new Set());
    setProcessing(true);

    try {
      // ── 1) 미송·보류 탭의 출고 (process_pending_ship) — 168 거래처 단위 ──
      // 같은 거래처의 다중 부모 derived (backorder_register / hold_register) 묶음 → 한 영수증.
      type PendingShipGroup = { parent_order_ids: Set<string>; items: Array<{ item_id: string; qty: number }> };
      const backorderByCustomer = new Map<string, PendingShipGroup>();
      const holdByCustomer      = new Map<string, PendingShipGroup>();
      for (const item of filteredItems) {
        if (!shipIds.has(item.id)) continue;
        if (item.process_type !== "backorder" && item.process_type !== "hold") continue;
        if (!item.customer_id) continue;
        const qty = parseInt((qtyInputs[item.id] ?? "").replace(/,/g, ""), 10) || 0;
        if (qty <= 0) continue;
        const map = item.process_type === "hold" ? holdByCustomer : backorderByCustomer;
        const g = map.get(item.customer_id) ?? { parent_order_ids: new Set<string>(), items: [] };
        g.parent_order_ids.add(item.order_id);
        g.items.push({ item_id: item.id, qty });
        map.set(item.customer_id, g);
      }
      for (const [customerId, g] of backorderByCustomer) {
        const { error } = await supabase.rpc("process_pending_ship", {
          p_tenant_id:          tenantId,
          p_customer_id:        customerId,
          p_original_order_ids: [...g.parent_order_ids],
          p_item_qty:           g.items,
          p_kind:               "backorder",
        });
        if (error) throw new Error("미송 출고 오류: " + error.message);
      }
      for (const [customerId, g] of holdByCustomer) {
        const { error } = await supabase.rpc("process_pending_ship", {
          p_tenant_id:          tenantId,
          p_customer_id:        customerId,
          p_original_order_ids: [...g.parent_order_ids],
          p_item_qty:           g.items,
          p_kind:               "hold",
        });
        if (error) throw new Error("보류 출고 오류: " + error.message);
      }

      // ── 2) 당일/미처리 탭의 처리 (process_register_action) ──
      // 167 정공법: 거래처 단위 묶음 → 한 RPC = 한 영수증 (출고+미송 통합).
      //   다중 staging (한 거래처에 N개 주문등록) 도 한 영수증으로 묶임.
      //   잔여 (토글 안 된 row + 부분 토글의 잔량) 는 RPC 가 자동 폐기.
      type ActionItem = { item_id: string; qty: number };
      type CustomerActions = {
        shipment: ActionItem[];
        backorder_register: ActionItem[];
        hold_register: ActionItem[];
        staging_order_ids: Set<string>;
      };
      const customerActionsMap = new Map<string, CustomerActions>();
      const ensureCustomer = (cid: string): CustomerActions => {
        const existing = customerActionsMap.get(cid);
        if (existing) return existing;
        const fresh: CustomerActions = { shipment: [], backorder_register: [], hold_register: [], staging_order_ids: new Set() };
        customerActionsMap.set(cid, fresh);
        return fresh;
      };

      for (const item of filteredItems) {
        if (!allToggled.has(item.id)) continue;
        if (item.process_type !== "ordered") continue;  // staging row 만
        if (!item.customer_id) continue;
        const qty = parseInt((qtyInputs[item.id] ?? "").replace(/,/g, ""), 10) || 0;
        const ca = ensureCustomer(item.customer_id);
        ca.staging_order_ids.add(item.order_id);

        if (shipIds.has(item.id) && backorderIds.has(item.id)) {
          // 출고 + 미송 동시 토글 — 출고분 + 잔여 미송으로 split (사장 의도: 잔여 살리기)
          if (qty > 0) ca.shipment.push({ item_id: item.id, qty });
          const remainder = item.quantity - qty;
          if (remainder > 0) ca.backorder_register.push({ item_id: item.id, qty: remainder });
        } else if (shipIds.has(item.id)) {
          const finalQty = qty > 0 ? qty : item.quantity;
          ca.shipment.push({ item_id: item.id, qty: finalQty });
        } else if (backorderIds.has(item.id)) {
          const finalQty = qty > 0 && qty < item.quantity ? qty : item.quantity;
          ca.backorder_register.push({ item_id: item.id, qty: finalQty });
        } else if (holdIds.has(item.id)) {
          const finalQty = qty > 0 && qty < item.quantity ? qty : item.quantity;
          ca.hold_register.push({ item_id: item.id, qty: finalQty });
        }
      }

      for (const [customerId, ca] of customerActionsMap) {
        const actionsList: Array<{ kind: string; items: ActionItem[] }> = [];
        if (ca.shipment.length           > 0) actionsList.push({ kind: "shipment",           items: ca.shipment });
        if (ca.backorder_register.length > 0) actionsList.push({ kind: "backorder_register", items: ca.backorder_register });
        if (ca.hold_register.length      > 0) actionsList.push({ kind: "hold_register",      items: ca.hold_register });
        if (actionsList.length === 0) continue;

        const stagingIds = [...ca.staging_order_ids];
        const { data, error } = await supabase.rpc("process_register_action", {
          p_tenant_id:         tenantId,
          p_customer_id:       customerId,
          p_staging_order_ids: stagingIds,
          p_actions:           actionsList,
        });
        if (error) throw new Error("처리 오류: " + error.message);
        const result = data as { success: boolean; error?: string };
        if (!result?.success) throw new Error("처리 실패: " + (result?.error ?? "알 수 없음"));
      }

      // ── 3) 미송 해제 (process_release_for_customer) ──
      if (releaseIds.size > 0) {
        const releaseItems = filteredItems.filter(i => releaseIds.has(i.id));
        const groupsByCustomer = new Map<string, { item_id: string; qty: number }[]>();
        for (const it of releaseItems) {
          if (!it.customer_id) continue;
          const inputQty = parseInt((qtyInputs[it.id] ?? "").replace(/,/g, ""), 10) || 0;
          const qty = inputQty > 0 ? Math.min(inputQty, it.remaining_qty) : it.remaining_qty;
          if (qty <= 0) continue;
          const arr = groupsByCustomer.get(it.customer_id) ?? [];
          arr.push({ item_id: it.id, qty });
          groupsByCustomer.set(it.customer_id, arr);
        }
        for (const [customerId, items] of groupsByCustomer) {
          const { data, error } = await supabase.rpc("process_release_for_customer", {
            p_tenant_id: tenantId, p_customer_id: customerId, p_items: items,
          });
          if (error) throw new Error("해제 오류: " + error.message);
          const result = data as { success: boolean; error?: string };
          if (!result?.success) throw new Error("해제 실패: " + (result?.error ?? "알 수 없음"));
        }
      }

      // ── 4) 삭제 (deleteIds) — staging row 만 (derived 박제 row 는 삭제 X) ──
      if (deleteIds.size > 0) {
        const ids = [...deleteIds];
        const affectedOrderIds = [...new Set(filteredItems.filter(i => ids.includes(i.id)).map(i => i.order_id))];
        const { error: itemErr } = await supabase.from("order_items").delete().in("id", ids);
        if (itemErr) throw new Error("삭제 오류: " + itemErr.message);
        for (const orderId of affectedOrderIds) {
          const { data: remaining } = await supabase.from("order_items").select("id").eq("order_id", orderId);
          if (!remaining?.length) {
            const { error: orderErr } = await supabase.from("orders").delete().eq("id", orderId);
            if (orderErr) throw new Error("주문 삭제 오류: " + orderErr.message);
          }
        }
      }

      clearToggles();
      fetchFlatItems(tenantId);
    } catch (e) {
      alert((e as Error).message);
    } finally {
      setProcessing(false);
    }
  }

  const filteredItems = useMemo(() => {
    const filtered = flatItems.filter(item => {
      if (filterOrder && !item.order_number.toLowerCase().includes(filterOrder.toLowerCase())) return false;
      if (filterCustomer && !item.company_name.includes(filterCustomer)) return false;
      if (filterProduct && !item.product_name.includes(filterProduct)) return false;
      if (sampleFilter === "order" && item.is_sample) return false;
      if (sampleFilter === "sample" && !item.is_sample) return false;

      // 당일/미처리 탭 = 일반 주문 (process_type='ordered') + 미처리 (status='unshipped') 만.
      //   처리된 행은 영수증 기준 탭으로 이관 — [취소] 폐지, 되돌리기는 영수증 기준 탭의 [반품] 흐름.
      //   사장 결정 (2026-05-06): 영수증 박제 = 비가역 기록 → 취소로 toggle 안 함.
      //   제외:
      //     - 미송/보류 (process_type='backorder'/'hold' → pending 탭)
      //     - 처리된 행 (status='shipped' → 영수증 기준 탭)
      //     - 샘플결제 derived (order_source='sample_convert' → 영수증 기준 탭)
      //     - 미송/보류 출고 derived (order_source='backorder_ship'/'hold_ship'/'pending_ship'
      //                              → 영수증 기준 탭)
      if (posTab === "today") {
        if (item.process_type !== "ordered") return false;
        if (item.status !== "unshipped") return false;
        if (item.order_source === "sample_convert") return false;
        if (item.order_source === "hold_ship" || item.order_source === "backorder_ship" || item.order_source === "pending_ship") return false;
      }
      // 미송·보류 탭 = backorder/hold 중 잔량 있는 것 (출고 대기) 만.
      //   완전 출고/해제 (status='shipped' + remaining_qty=0) 는 제외
      // 148 도 원본 remaining_qty/status mutate 하므로 단순 status+remaining_qty 로 정합.
      if (posTab === "pending") {
        if (item.process_type !== "backorder" && item.process_type !== "hold") return false;
        if (item.status !== "unshipped") return false;
        if ((item.remaining_qty ?? 0) <= 0) return false;
      }
      return true;
    });
    if (productSort === "customer") {
      // 거래처순 — 같은 거래처 내에서는 일시 내림차순 유지
      return [...filtered].sort((a, b) => {
        const c = a.company_name.localeCompare(b.company_name, "ko");
        if (c !== 0) return c;
        return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
      });
    }
    return filtered;
  }, [flatItems, filterOrder, filterCustomer, filterProduct, sampleFilter, productSort, posTab]);

  const hasFilter = filterOrder || filterCustomer || filterProduct || sampleFilter !== "all";
  const selectedOrder = orders.find(o => o.id === selectedOrderId) ?? null;

  // 풀폭 5:5 큰 탭 버튼 — "주문" / "입금처리". default = "주문".
  const tabButtons = (
    <div className="grid grid-cols-2 w-full gap-0">
      {(["sale", "receipt"] as const).map((key, i) => (
        <button
          key={key}
          onClick={() => setTab(key)}
          title={`${key} 탭 (단축키 ${i + 1})`}
          className={`py-3 text-base font-semibold transition-colors border-b-2 ${
            tab === key
              ? "border-primary text-primary bg-primary-soft"
              : "border-gray-200 text-gray-500 hover:text-gray-700 hover:bg-gray-50"
          }`}
        >
          {{ sale: "주문", receipt: "주문조회/입금처리" }[key]}
          <kbd className="ml-2 text-[10px] font-normal opacity-60">{i + 1}</kbd>
        </button>
      ))}
    </div>
  );

  // 선택 행 기반 미발송 3종 — today/pending 탭 액션 띠 좌측 공통.
  // 라디오로 한 행 선택 → 그 행의 거래처/상품 기준으로 미발송 모달 호출.
  const selectedFlatActions = (() => {
    const sel = filteredItems.find(i => i.id === selectedFlatItemId) ?? null;
    const disabled = !sel;
    const baseCls = "px-3 py-1.5 text-xs font-medium rounded-lg border transition-colors";
    const enabledCls = "bg-white text-gray-800 border-gray-300 hover:bg-gray-50";
    const disabledCls = "bg-gray-50 text-gray-300 border-gray-200 cursor-not-allowed";
    return (
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-xs text-gray-400">
          {sel ? `선택: ${sel.company_name} · ${sel.product_name}` : "행을 선택하세요"}
        </span>
        <button disabled={disabled || !sel?.customer_id}
          onClick={() => sel && setPendingModal({ kind: "customer", customerId: sel.customer_id, session: "today" })}
          className={`${baseCls} ${disabled ? disabledCls : enabledCls}`}>미발송(당일)</button>
        <button disabled={disabled || !sel?.customer_id}
          onClick={() => sel && setPendingModal({ kind: "customer", customerId: sel.customer_id, session: "all" })}
          className={`${baseCls} ${disabled ? disabledCls : enabledCls}`}>미발송(전체)</button>
        <button disabled={disabled || !sel?.product_id}
          onClick={() => sel?.product_id && setPendingModal({ kind: "product", productId: sel.product_id })}
          className={`${baseCls} ${disabled ? disabledCls : enabledCls}`}>미발송(상품)</button>
        {sel && (
          <button onClick={() => setSelectedFlatItemId(null)}
            className="text-xs text-gray-400 hover:text-gray-600 underline">선택 해제</button>
        )}
      </div>
    );
  })();

  // 주문처리 패널 — product 탭 + sale 탭 우측에서 동일하게 재사용
  // overflow-y-auto: viewport 작을 때 패널 자체 스크롤 → 하단 [처리!] 띠가 sticky bottom-0 으로 viewport 바닥 유지.
  // overflow-x-hidden: 액션 띠의 -mx-4 (패널 끝 확장) 가 가로 스크롤 만드는 것 차단.
  const productPanel = (
        <div className="flex flex-row flex-1 min-h-0">
          {/* 세로 탭 — 당일/미처리 / 미송·보류 / 샘플. 세로 1:1:1.
              우측 그리드와 연결되는 디자인: 탭 영역 회색 배경, 각 탭 사이 간격, active 탭은 흰색(그리드 색)으로 우측 연결. */}
          <div className="flex flex-col shrink-0 -ml-4 -my-3 mr-4 bg-gray-100 w-16 gap-1 py-2 pl-1">
            {([["today","미처리"],["pending","미송·보류"],["sample","샘플"]] as const).map(([k, l]) => {
              const active = posTab === k;
              return (
                <button key={k} onClick={() => setPosTab(k)}
                  className={`flex-1 flex flex-col items-center justify-center py-4 text-base font-semibold leading-relaxed rounded-l-xl transition-colors ${
                    active
                      ? "bg-primary-soft text-primary font-bold shadow-[inset_4px_0_0_0_var(--color-primary,#7c3aed)]"
                      : "text-gray-600 hover:bg-white/60"
                  }`}>
                  {l.split("").map((ch, i) => (
                    <span key={i}>{ch}</span>
                  ))}
                </button>
              );
            })}
          </div>

          {/* 우측 — 탭별 내용 영역 (스크롤 컨테이너) */}
          <div className="flex flex-col flex-1 min-w-0 overflow-y-auto overflow-x-hidden">
          {posTab === "today" && (<>
          <div className="flex items-center gap-2 mb-3 shrink-0">
            <input type="text" value={filterCustomer} onChange={e => setFilterCustomer(e.target.value)}
              placeholder="거래처"
              className={`w-32 ${INPUT_SM}`} />
            <input type="text" value={filterProduct} onChange={e => setFilterProduct(e.target.value)}
              placeholder="상품명"
              className={`w-32 ${INPUT_SM}`} />
            <div className="flex rounded-lg border border-gray-300 overflow-hidden text-xs">
              {([["all","전체"],["order","주문만"],["sample","샘플만"]] as const).map(([k, l]) => (
                <button key={k} onClick={() => setSampleFilter(k)}
                  className={`px-3 py-1.5 transition-colors ${sampleFilter === k ? "bg-primary text-white" : "text-gray-600 hover:bg-gray-50"}`}>
                  {l}
                </button>
              ))}
            </div>
            <div className="flex rounded-lg border border-gray-300 overflow-hidden text-xs">
              {([["time","일시순"],["customer","거래처순"]] as const).map(([k, l]) => (
                <button key={k} onClick={() => setProductSort(k)}
                  className={`px-3 py-1.5 transition-colors ${productSort === k ? "bg-primary text-white" : "text-gray-600 hover:bg-gray-50"}`}>
                  {l}
                </button>
              ))}
            </div>
            {hasFilter && (
              <button
                onClick={() => { setFilterOrder(""); setFilterCustomer(""); setFilterProduct(""); setSampleFilter("all"); }}
                className="px-3 py-1.5 text-xs text-gray-500 border border-gray-200 rounded-lg hover:bg-gray-50"
              >초기화</button>
            )}
            <span className="ml-auto text-xs text-gray-400">
              {filteredItems.length}건
              {hasFilter && flatItems.length !== filteredItems.length && ` / 전체 ${flatItems.length}건`}
            </span>
          </div>

          <div className="flex-1 min-h-0">
            <DataTable maxHeight="100%">
              <TableHead>
                <Th>일시</Th><Th>거래처</Th><Th>상품명</Th><Th>색상</Th><Th>사이즈</Th>
                <Th>단가</Th><Th>주문</Th><Th>금액</Th>
                <Th>재고</Th><Th>수량</Th><Th>결제</Th><Th></Th><Th></Th>
              </TableHead>
              <tbody>
                {loadingFlat ? (
                  <LoadingRow colSpan={13} />
                ) : filteredItems.length === 0 ? (
                  <EmptyRow colSpan={13} message={hasFilter ? "검색 결과가 없습니다." : "주문 내역이 없습니다."} />
                ) : filteredItems.map(item => (
                  <tr key={item.id} className={`border-b border-gray-100 transition-colors ${(() => {
                    const s = shipStatus(item.status, item.shipped_qty, item.quantity);
                    if (item.is_sample && s !== "shipped") return "bg-amber-50/40 hover:bg-amber-50";
                    if (item.is_exchange && s !== "shipped") return "bg-emerald-50/60 hover:bg-emerald-100/60";
                    if (s === "shipped" || s === "partial") return item.is_sample ? "bg-amber-50/40 hover:bg-amber-50" : "bg-primary-soft/40 hover:bg-primary-soft/60";
                    if (s === "released") return "bg-gray-50 hover:bg-gray-100/60";
                    if (item.process_type === "backorder") return "bg-orange-50/60 hover:bg-orange-100/60";
                    if (item.process_type === "hold") return "bg-yellow-50/60 hover:bg-yellow-100/60";
                    return "hover:bg-gray-50";
                  })()}`}>
                    <td className="px-2 py-1.5 text-center text-xs text-gray-500 whitespace-nowrap">{item.created_at ? formatOrderTime(item.created_at) : "-"}</td>
                    <td className="px-2 py-1.5 text-xs font-medium text-gray-800 max-w-[120px]">
                      <div className="flex items-center gap-1">
                        <span className="truncate" title={item.company_name}>{item.company_name}</span>
                        {item.order_source === "external_inbox" && <ProcessBadge kind="외" />}
                        {item.is_sample && <ProcessBadge kind="샘플" />}
                        {item.order_source === "sample_convert" && <ProcessBadge kind="샘결" />}
                      </div>
                    </td>
                    <td className="px-2 py-1.5 text-xs font-medium text-gray-800">{item.product_name}</td>
                    <td className="px-2 py-1.5 text-center text-xs text-gray-600">{item.color}</td>
                    <td className="px-2 py-1.5 text-center text-xs text-gray-600">{item.size}</td>
                    <td className="px-2 py-1.5 text-right text-xs text-gray-700">{krw(item.unit_price)}</td>
                    <td className="px-2 py-1.5 text-center text-xs font-medium text-gray-900">{item.quantity}</td>
                    <td className="px-2 py-1.5 text-right text-xs font-medium text-gray-900">{krw(item.total_price)}</td>
                    <td className="px-2 py-1.5 text-center text-xs text-gray-700">
                      {inventoryMap[item.variant_id] ?? <span className="text-gray-300">—</span>}
                    </td>
                    <td className="px-2 py-1.5 text-center">
                      <input
                        type="text" inputMode="numeric"
                        value={qtyInputs[item.id] ?? ""}
                        placeholder="0"
                        ref={el => { if (el) inputRefs.current.set(item.id, el); else inputRefs.current.delete(item.id); }}
                        onChange={e => {
                          const raw = e.target.value.replace(/[^0-9]/g, "");
                          const num = parseInt(raw, 10);
                          setQtyInputs(prev => ({ ...prev, [item.id]: isNaN(num) ? "" : num.toLocaleString() }));
                          setErrorIds(prev => { const s = new Set(prev); s.delete(item.id); return s; });
                        }}
                        onKeyDown={e => {
                          if (!["ArrowDown", "ArrowUp", "Enter"].includes(e.key)) return;
                          e.preventDefault();
                          const ids = filteredItems.map(i => i.id);
                          const next = ids.indexOf(item.id) + (e.key === "ArrowUp" ? -1 : 1);
                          if (next >= 0 && next < ids.length) inputRefs.current.get(ids[next])?.focus();
                        }}
                        className={`w-14 px-1 py-0.5 border rounded text-xs text-center focus:outline-none focus:ring-1 focus:ring-primary-ring ${
                          errorIds.has(item.id) ? "border-orange-400 bg-orange-100" :
                          (parseInt((qtyInputs[item.id] ?? "").replace(/,/g, ""), 10) || 0) > (inventoryMap[item.variant_id] ?? 0) ? "border-red-300 bg-red-50" :
                          "border-gray-300"
                        }`}
                      />
                    </td>
                    <td className="px-2 py-1.5 text-center text-xs text-gray-700">
                      {METHOD_LABELS[customerPaymentMethods[item.customer_id] ?? ""] ?? "—"}
                    </td>
                    <td className="px-2 py-1.5 text-center">
                      {item.status === "unshipped" && item.process_type === "ordered" && (
                        <div className="flex gap-1 justify-center flex-wrap">
                          <button onClick={() => toggleShip(item.id)}
                            className={`px-2 py-0.5 text-xs font-medium rounded border transition-colors ${shipIds.has(item.id) ? "bg-primary text-white border-primary" : "bg-primary-soft text-primary border-primary-border hover:bg-primary-soft-hover"}`}>당일</button>
                          {/* 샘플은 [미송] 차단 — 미송 변환 후 출고 시 영수증/외상 잘못 잡힘 */}
                          {!item.is_sample && (
                            <button onClick={() => toggleBackorder(item.id)}
                              className={`px-2 py-0.5 text-xs font-medium rounded border transition-colors ${backorderIds.has(item.id) ? "bg-orange-500 text-white border-orange-500" : "bg-orange-50 text-orange-600 border-orange-200 hover:bg-orange-100"}`}>미송</button>
                          )}
                          <button onClick={() => toggleHold(item.id)}
                            className={`px-2 py-0.5 text-xs font-medium rounded border transition-colors ${holdIds.has(item.id) ? "bg-yellow-500 text-white border-yellow-500" : "bg-yellow-50 text-yellow-600 border-yellow-200 hover:bg-yellow-100"}`}>보류</button>
                        </div>
                      )}
                      {item.status === "unshipped" && (item.process_type === "backorder" || item.process_type === "hold") && (
                        <div className="flex gap-1 justify-center flex-wrap">
                          <button onClick={() => toggleShip(item.id)}
                            className={`px-2 py-0.5 text-xs font-medium rounded border transition-colors ${shipIds.has(item.id) ? "bg-primary text-white border-primary" : "bg-primary-soft text-primary border-primary-border hover:bg-primary-soft-hover"}`}>당일</button>
                          {!item.is_exchange && (
                            <button onClick={() => toggleRelease(item.id)}
                              className={`px-2 py-0.5 text-xs font-medium rounded border transition-colors ${releaseIds.has(item.id) ? "bg-gray-500 text-white border-gray-500" : "bg-gray-50 text-gray-600 border-gray-300 hover:bg-gray-100"}`}>해제</button>
                          )}
                        </div>
                      )}
                    </td>
                    <td className="px-2 py-1.5 text-center">
                      <div className="flex flex-col gap-1 items-center">
                        {/* [취소] 폐지 (2026-05-06 사장 결정) — 영수증 박제는 비가역.
                            출고 되돌리기는 영수증 기준 탭의 [반품] / 샘플 관리 탭의 [반납] 으로. */}
                        {item.status === "unshipped" && item.process_type === "ordered" && (
                          <button onClick={() => toggleDelete(item.id)}
                            className={`px-2 py-0.5 text-xs font-medium rounded border transition-colors ${deleteIds.has(item.id) ? "bg-red-600 text-white border-red-600" : "bg-red-50 text-red-500 border-red-200 hover:bg-red-100"}`}>삭제</button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </DataTable>
          </div>

          <div className="-mx-4 shrink-0 sticky bottom-0 z-20 flex justify-end items-center px-4 py-3 gap-2 flex-wrap bg-white border-t border-gray-200 shadow-[0_-2px_6px_rgba(0,0,0,0.04)] min-h-[120px]">
            {(() => {
              const total = new Set([...shipIds, ...backorderIds, ...holdIds, ...releaseIds, ...deleteIds]).size;
              return (
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
            })()}
          </div>
          </>)}

          {posTab === "pending" && (<>
          <div className="flex items-center gap-2 mb-3 shrink-0">
            <input type="text" value={filterOrder} onChange={e => setFilterOrder(e.target.value)}
              placeholder="주문번호"
              className={`w-36 ${INPUT_SM}`} />
            <input type="text" value={filterCustomer} onChange={e => setFilterCustomer(e.target.value)}
              placeholder="거래처"
              className={`w-32 ${INPUT_SM}`} />
            <input type="text" value={filterProduct} onChange={e => setFilterProduct(e.target.value)}
              placeholder="상품명"
              className={`w-32 ${INPUT_SM}`} />
            <div className="flex rounded-lg border border-gray-300 overflow-hidden text-xs">
              {([["all","전체"],["order","주문만"],["sample","샘플만"]] as const).map(([k, l]) => (
                <button key={k} onClick={() => setSampleFilter(k)}
                  className={`px-3 py-1.5 transition-colors ${sampleFilter === k ? "bg-primary text-white" : "text-gray-600 hover:bg-gray-50"}`}>
                  {l}
                </button>
              ))}
            </div>
            <div className="flex rounded-lg border border-gray-300 overflow-hidden text-xs">
              {([["time","일시순"],["customer","거래처순"]] as const).map(([k, l]) => (
                <button key={k} onClick={() => setProductSort(k)}
                  className={`px-3 py-1.5 transition-colors ${productSort === k ? "bg-primary text-white" : "text-gray-600 hover:bg-gray-50"}`}>
                  {l}
                </button>
              ))}
            </div>
            {hasFilter && (
              <button
                onClick={() => { setFilterOrder(""); setFilterCustomer(""); setFilterProduct(""); setSampleFilter("all"); }}
                className="px-3 py-1.5 text-xs text-gray-500 border border-gray-200 rounded-lg hover:bg-gray-50"
              >초기화</button>
            )}
            <span className="ml-auto text-xs text-gray-400">
              {filteredItems.length}건
              {hasFilter && flatItems.length !== filteredItems.length && ` / 전체 ${flatItems.length}건`}
            </span>
          </div>

          <div className="flex-1 min-h-0">
            <DataTable maxHeight="100%">
              <TableHead>
                <Th className="w-8 px-1"></Th>
                <Th>일시</Th><Th>거래처</Th><Th>상품명</Th><Th>색상</Th><Th>사이즈</Th>
                <Th>단가</Th><Th>주문</Th><Th>금액</Th>
                <Th>재고</Th><Th>잔량</Th><Th>수량</Th><Th>결제</Th><Th></Th>
              </TableHead>
              <tbody>
                {loadingFlat ? (
                  <LoadingRow colSpan={14} />
                ) : filteredItems.length === 0 ? (
                  <EmptyRow colSpan={14} message={hasFilter ? "검색 결과가 없습니다." : "주문 내역이 없습니다."} />
                ) : filteredItems.map(item => (
                  <tr key={item.id} className={`border-b border-gray-100 transition-colors ${(() => {
                    const s = shipStatus(item.status, item.shipped_qty, item.quantity);
                    if (item.is_sample && s !== "shipped") return "bg-amber-50/40 hover:bg-amber-50";
                    if (item.is_exchange && s !== "shipped") return "bg-emerald-50/60 hover:bg-emerald-100/60";
                    if (s === "shipped" || s === "partial") return item.is_sample ? "bg-amber-50/40 hover:bg-amber-50" : "bg-primary-soft/40 hover:bg-primary-soft/60";
                    if (s === "released") return "bg-gray-50 hover:bg-gray-100/60";
                    if (item.process_type === "backorder") return "bg-orange-50/60 hover:bg-orange-100/60";
                    if (item.process_type === "hold") return "bg-yellow-50/60 hover:bg-yellow-100/60";
                    return "hover:bg-gray-50";
                  })()}`}>
                    <td className="px-1 py-1.5 text-center">
                      <input type="radio" name="product-row-select-pending"
                        checked={selectedFlatItemId === item.id}
                        onChange={() => setSelectedFlatItemId(item.id)}
                        title="선택 — 거래처/상품 단위 액션 활성화"
                        className="w-3.5 h-3.5 cursor-pointer accent-primary" />
                    </td>
                    <td className="px-2 py-1.5 text-center text-xs text-gray-500 whitespace-nowrap">{item.created_at ? formatOrderTime(item.created_at) : "-"}</td>
                    <td className="px-2 py-1.5 text-xs font-medium text-gray-800 max-w-[120px]">
                      <div className="flex items-center gap-1">
                        <span className="truncate" title={item.company_name}>{item.company_name}</span>
                        {item.order_source === "external_inbox" && <ProcessBadge kind="외" />}
                        {item.is_sample && <ProcessBadge kind="샘플" />}
                        {item.order_source === "sample_convert" && <ProcessBadge kind="샘결" />}
                      </div>
                    </td>
                    <td className="px-2 py-1.5 text-xs font-medium text-gray-800">{item.product_name}</td>
                    <td className="px-2 py-1.5 text-center text-xs text-gray-600">{item.color}</td>
                    <td className="px-2 py-1.5 text-center text-xs text-gray-600">{item.size}</td>
                    <td className="px-2 py-1.5 text-right text-xs text-gray-700">{krw(item.unit_price)}</td>
                    <td className="px-2 py-1.5 text-center text-xs font-medium text-gray-900">{item.quantity}</td>
                    <td className="px-2 py-1.5 text-right text-xs font-medium text-gray-900">{krw(item.total_price)}</td>
                    <td className="px-2 py-1.5 text-center text-xs text-gray-700">
                      {inventoryMap[item.variant_id] ?? <span className="text-gray-300">—</span>}
                    </td>
                    <td className="px-2 py-1.5 text-center">
                      <div className="flex items-center justify-center gap-1">
                        {item.process_type === "backorder" && <ProcessBadge kind="미송" />}
                        {item.process_type === "hold" && <ProcessBadge kind="보류" />}
                        <span className="text-xs text-gray-700">{item.remaining_qty}</span>
                      </div>
                    </td>
                    <td className="px-2 py-1.5 text-center">
                      <input
                        type="text" inputMode="numeric"
                        value={qtyInputs[item.id] ?? ""}
                        placeholder="0"
                        ref={el => { if (el) inputRefs.current.set(item.id, el); else inputRefs.current.delete(item.id); }}
                        onChange={e => {
                          const raw = e.target.value.replace(/[^0-9]/g, "");
                          const num = parseInt(raw, 10);
                          setQtyInputs(prev => ({ ...prev, [item.id]: isNaN(num) ? "" : num.toLocaleString() }));
                          setErrorIds(prev => { const s = new Set(prev); s.delete(item.id); return s; });
                        }}
                        onKeyDown={e => {
                          if (!["ArrowDown", "ArrowUp", "Enter"].includes(e.key)) return;
                          e.preventDefault();
                          const ids = filteredItems.map(i => i.id);
                          const next = ids.indexOf(item.id) + (e.key === "ArrowUp" ? -1 : 1);
                          if (next >= 0 && next < ids.length) inputRefs.current.get(ids[next])?.focus();
                        }}
                        className={`w-14 px-1 py-0.5 border rounded text-xs text-center focus:outline-none focus:ring-1 focus:ring-primary-ring ${
                          errorIds.has(item.id) ? "border-orange-400 bg-orange-100" :
                          (parseInt((qtyInputs[item.id] ?? "").replace(/,/g, ""), 10) || 0) > (inventoryMap[item.variant_id] ?? 0) ? "border-red-300 bg-red-50" :
                          "border-gray-300"
                        }`}
                      />
                    </td>
                    <td className="px-2 py-1.5 text-center text-xs text-gray-700">
                      {METHOD_LABELS[customerPaymentMethods[item.customer_id] ?? ""] ?? "—"}
                    </td>
                    <td className="px-2 py-1.5 text-center">
                      {item.status === "unshipped" && item.process_type === "ordered" && (
                        <div className="flex gap-1 justify-center flex-wrap">
                          <button onClick={() => toggleShip(item.id)}
                            className={`px-2 py-0.5 text-xs font-medium rounded border transition-colors ${shipIds.has(item.id) ? "bg-primary text-white border-primary" : "bg-primary-soft text-primary border-primary-border hover:bg-primary-soft-hover"}`}>당일</button>
                          {/* 샘플은 [미송] 차단 — 미송 변환 후 출고 시 영수증/외상 잘못 잡힘 */}
                          {!item.is_sample && (
                            <button onClick={() => toggleBackorder(item.id)}
                              className={`px-2 py-0.5 text-xs font-medium rounded border transition-colors ${backorderIds.has(item.id) ? "bg-orange-500 text-white border-orange-500" : "bg-orange-50 text-orange-600 border-orange-200 hover:bg-orange-100"}`}>미송</button>
                          )}
                          <button onClick={() => toggleHold(item.id)}
                            className={`px-2 py-0.5 text-xs font-medium rounded border transition-colors ${holdIds.has(item.id) ? "bg-yellow-500 text-white border-yellow-500" : "bg-yellow-50 text-yellow-600 border-yellow-200 hover:bg-yellow-100"}`}>보류</button>
                        </div>
                      )}
                      {item.status === "unshipped" && (item.process_type === "backorder" || item.process_type === "hold") && (
                        <div className="flex gap-1 justify-center flex-wrap">
                          <button onClick={() => toggleShip(item.id)}
                            className={`px-2 py-0.5 text-xs font-medium rounded border transition-colors ${shipIds.has(item.id) ? "bg-primary text-white border-primary" : "bg-primary-soft text-primary border-primary-border hover:bg-primary-soft-hover"}`}>당일</button>
                          {!item.is_exchange && (
                            <button onClick={() => toggleRelease(item.id)}
                              className={`px-2 py-0.5 text-xs font-medium rounded border transition-colors ${releaseIds.has(item.id) ? "bg-gray-500 text-white border-gray-500" : "bg-gray-50 text-gray-600 border-gray-300 hover:bg-gray-100"}`}>해제</button>
                          )}
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </DataTable>
          </div>

          <div className="-mx-4 shrink-0 sticky bottom-0 z-20 flex justify-between items-center px-4 py-3 gap-2 flex-wrap bg-white border-t border-gray-200 shadow-[0_-2px_6px_rgba(0,0,0,0.04)] min-h-[120px]">
            {selectedFlatActions}
            {(() => {
              const total = new Set([...shipIds, ...backorderIds, ...holdIds, ...releaseIds, ...deleteIds]).size;
              return (
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
            })()}
          </div>
          </>)}

          {posTab === "sample" && tenantId && (<>
            <div className="flex-1 min-h-0 overflow-auto">
              <SamplesView tenantId={tenantId} actionBarTarget={sampleActionBarEl} />
            </div>
            <div ref={setSampleActionBarEl}
              className="-mx-4 shrink-0 sticky bottom-0 z-20 flex justify-end items-center px-4 py-3 gap-2 flex-wrap bg-white border-t border-gray-200 shadow-[0_-2px_6px_rgba(0,0,0,0.04)] min-h-[120px]" />
          </>)}
          </div>
        </div>
  );

  // 주문등록 탭 — 좌측 SaleForm(compact) + 우측 주문처리 패널.
  // main(p-8) padding 상쇄 위해 root 자체 -m-8 + h-100vh.
  if (tab === "sale" && tenantId) {
    return (
      <div className="-m-8 flex flex-col" style={{ height: "100vh" }}>
        <div className="flex flex-1 min-h-0">
          {/* 좌측 — SaleForm compact (카테고리/영수증미리보기 hide) */}
          <div className="w-[560px] shrink-0 border-r border-gray-200 flex flex-col">
            <SaleForm
              tenantId={tenantId}
              tenantCode={tenantCode}
              compact
              onSaveSuccess={(_o: SavedOrder) => {
                fetchFlatItems(tenantId);
                // 등록/즉시출고/샘플 후 우측 inner 탭을 항상 first(today)로 — 사장 UX 요구.
                setPosTab("today");
              }}
            />
          </div>
          {/* 우측 — 주문처리 패널 (productPanel 재사용) */}
          <div className="flex-1 min-w-0 flex flex-col px-4 pt-3 overflow-hidden">
            {productPanel}
          </div>
        </div>

        {/* 모달 — sale 탭에서도 selectedFlatActions 의 미발송 3종 / 영수증 출력 동작 */}
        {receiptModal && (
          <ReceiptPrintModal
            orderId={receiptModal.orderId}
            onClose={() => setReceiptModal(null)}
          />
        )}
        {pendingModal && (
          <PendingPrintModal
            mode={pendingModal}
            onClose={() => setPendingModal(null)}
          />
        )}
        {/* 하단 풀폭 탭바 — 주문/입금처리 5:5 (관리자 요청 2026-05-11). */}
        <div className="shrink-0 border-t border-gray-200 bg-white">
          {tabButtons}
        </div>
      </div>
    );
  }

  return (
    <div className="-m-8 flex flex-col" style={{ height: "100vh" }}>

      <div className="flex-1 min-h-0 overflow-hidden flex flex-col px-4 pt-3">

      {/* 샘플 관리 탭 제거 — productPanel 의 inner "샘플" 탭으로 통합 */}

      {/* 영수증 기준 탭 + 과거주문조회 탭 — 같은 JSX 블록 공유. 데이터 소스만 다름. */}
      {tab === "receipt" && (
        <div className="flex flex-col gap-2 flex-1 min-h-0">
          {/* 필터바 — 거래처 검색 + 영업세션 다중선택 (개시 KST 기준). 사장 결정 2026-05-18. */}
          <div className="flex items-center gap-2 flex-shrink-0 px-1">
            <input
              type="text"
              placeholder="거래처 검색"
              value={customerSearch}
              onChange={(e) => { setCustomerSearch(e.target.value); setPageOffset(0); }}
              className="px-3 py-1.5 text-sm border border-gray-300 rounded-lg w-48 focus:outline-none focus:ring-2 focus:ring-primary"
            />

            {/* 영업세션 다중선택 dropdown */}
            <div className="relative" ref={sessionDropdownRef}>
              <button
                type="button"
                onClick={() => setSessionDropdownOpen(o => !o)}
                className="px-3 py-1.5 text-sm border border-gray-300 rounded-lg bg-white hover:bg-gray-50 flex items-center gap-2 min-w-[200px] justify-between"
              >
                <span className="text-gray-700">
                  {selectedSessionIds.length === 0
                    ? <span className="text-gray-400">영업세션 (전체)</span>
                    : <>영업세션 <span className="font-medium">{selectedSessionIds.length}개</span> 선택</>}
                </span>
                <span className="text-gray-400 text-xs">▼</span>
              </button>
              {sessionDropdownOpen && (
                <div className="absolute top-full left-0 mt-1 bg-white border border-gray-200 rounded-lg shadow-lg z-50 w-96 max-h-[28rem] overflow-y-auto">
                  <div className="sticky top-0 bg-white border-b border-gray-100 px-3 py-2 flex items-center justify-between z-10">
                    <span className="text-xs text-gray-500">최근 {bizSessions.length}개 세션</span>
                    <div className="flex gap-3">
                      <button
                        type="button"
                        onClick={() => { setSelectedSessionIds(bizSessions.map(s => s.id)); setPageOffset(0); }}
                        className="text-xs text-primary hover:underline"
                      >전체선택</button>
                      <button
                        type="button"
                        onClick={() => { setSelectedSessionIds([]); setPageOffset(0); }}
                        className="text-xs text-gray-500 hover:underline"
                      >해제</button>
                    </div>
                  </div>
                  {bizSessions.map(s => {
                    const checked = selectedSessionIds.includes(s.id);
                    const isActive = s.status === "active";
                    return (
                      <label
                        key={s.id}
                        className="flex items-center gap-2 px-3 py-2 hover:bg-gray-50 cursor-pointer border-b border-gray-50"
                      >
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => {
                            setSelectedSessionIds(prev =>
                              checked ? prev.filter(id => id !== s.id) : [...prev, s.id]
                            );
                            setPageOffset(0);
                          }}
                          className="rounded"
                        />
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="text-sm font-medium text-gray-800">{formatKstDateOnly(s.opened_at)}</span>
                            {isActive ? (
                              <span className="text-[10px] px-1.5 py-0.5 bg-green-100 text-green-700 rounded font-medium">활성</span>
                            ) : (
                              <span className="text-[10px] px-1.5 py-0.5 bg-gray-100 text-gray-500 rounded">정산</span>
                            )}
                          </div>
                          {s.sales_count !== null && s.sales_amount !== null ? (
                            <div className="text-xs text-gray-500 mt-0.5">
                              매출 ₩{krw(s.sales_amount)} · {s.sales_count}건
                            </div>
                          ) : isActive ? (
                            <div className="text-xs text-gray-400 mt-0.5">진행 중</div>
                          ) : null}
                        </div>
                      </label>
                    );
                  })}
                  {bizSessions.length === 0 && (
                    <div className="px-3 py-8 text-center text-sm text-gray-400">영업세션이 없습니다.</div>
                  )}
                </div>
              )}
            </div>

            {/* 빠른 선택 버튼 — 활성/최근7/전체 (사장 결정 2026-05-18) */}
            <div className="flex items-center gap-1">
              <span className="text-xs text-gray-400 mr-1">빠른:</span>
              <button
                type="button"
                onClick={() => {
                  const active = bizSessions.find(s => s.status === "active");
                  setSelectedSessionIds(active ? [active.id] : []);
                  setPageOffset(0);
                }}
                className="px-2 py-1 text-xs border border-gray-300 rounded bg-white hover:bg-gray-50"
                title="현재 활성 세션만"
              >활성</button>
              <button
                type="button"
                onClick={() => {
                  setSelectedSessionIds(bizSessions.slice(0, 7).map(s => s.id));
                  setPageOffset(0);
                }}
                className="px-2 py-1 text-xs border border-gray-300 rounded bg-white hover:bg-gray-50"
                title="최근 7개 세션 (≈ 이번주)"
              >최근7</button>
              <button
                type="button"
                onClick={() => {
                  setSelectedSessionIds(bizSessions.map(s => s.id));
                  setPageOffset(0);
                }}
                className="px-2 py-1 text-xs border border-gray-300 rounded bg-white hover:bg-gray-50"
                title="최근 30개 세션 (≈ 이번달)"
              >전체</button>
            </div>

            {/* 검색 결과 카운트 — "더보기" 버튼은 테이블 하단에 (처리 폼과 충돌 회피 + 스크롤 끝 자연) */}
            <div className="text-xs text-gray-500 ml-auto pr-2">
              총 <span className="font-medium text-gray-700">{totalCount.toLocaleString()}</span>건
              {totalCount > 0 && orders.length < totalCount && (
                <span className="ml-1 text-gray-400">· {orders.length.toLocaleString()}건 표시</span>
              )}
            </div>
          </div>

          <div className="flex gap-4 flex-1 min-h-0">

            {/* 주문 목록 + 입금처리 폼.
                overflow-y-scroll + scrollbar-gutter:stable: viewport 작을 때 scrollbar toggle 로
                clientWidth 진동 → ReceiptPreview ResizeObserver 떨림 차단. */}
            <div className="flex flex-col flex-[12] min-w-0 min-h-0 overflow-y-scroll overflow-x-hidden [scrollbar-gutter:stable]">
              <DataTable maxHeight="none" className="flex-1 overflow-auto">
                <TableHead>
                  <Th className="w-10">No</Th>
                  <Th>일시</Th>
                  <Th>거래처</Th>
                  <Th>수량</Th>
                  <Th>판매 <span className="text-[10px] font-normal text-gray-400">(vat별도)</span></Th>
                  <Th>외상/매입</Th>
                  <Th>결제</Th>
                  <Th className="px-2">당일처리</Th>
                  <Th className="px-2">입출금</Th>
                </TableHead>
                <tbody>
                  {(() => {
                    const filteredOrders = orders;
                    if (loadingOrders) return <LoadingRow colSpan={9} />;
                    if (filteredOrders.length === 0) return <EmptyRow colSpan={9} message="주문 내역이 없습니다." />;
                    return filteredOrders.map((order, i) => {
                    const bal = customerBalances[order.customer_id] ?? 0;
                    const isPaid = order.payment_status === "paid";
                    const isLoading = dayProcessing === order.id;
                    const isFormOpen = paymentForm?.customerId === order.customer_id;
                    // 세션 경계 separator — 이전 row 와 biz_session_id 다르면 굵은 헤더 row 삽입.
                    const prevOrder = i > 0 ? filteredOrders[i - 1] : null;
                    const showSessionHeader = order.biz_session_id && (!prevOrder || prevOrder.biz_session_id !== order.biz_session_id);
                    const session = order.biz_session_id ? sessionInfoMap[order.biz_session_id] : null;
                    return (
                      <Fragment key={order.id}>
                      {showSessionHeader && (
                        <tr className="bg-gray-100 border-y border-gray-300">
                          <td colSpan={9} className="px-3 py-1.5 text-xs font-semibold text-gray-700">
                            {session ? (
                              <span className="flex items-center gap-2">
                                <span>═══ {formatKstDateOnly(session.opened_at)}</span>
                                {session.status === "active" ? (
                                  <span className="px-1.5 py-0.5 bg-green-100 text-green-700 rounded text-[10px]">활성</span>
                                ) : (
                                  <span className="px-1.5 py-0.5 bg-gray-200 text-gray-600 rounded text-[10px]">정산</span>
                                )}
                                {session.sales_count !== null && session.sales_amount !== null && (
                                  <span className="text-gray-500 font-normal">· 매출 ₩{krw(session.sales_amount)} · {session.sales_count}건</span>
                                )}
                                <span className="text-gray-400">═══</span>
                              </span>
                            ) : (
                              <span className="text-gray-500">═══ 세션 정보 없음 ═══</span>
                            )}
                          </td>
                        </tr>
                      )}
                      <tr
                        className={`border-b transition-colors ${
                          selectedOrderId === order.id                                  ? "border-gray-100 bg-primary-soft" :
                          /* 빨간 음영 = 미입금 영수증 (외상 잔액 > 0) 만. 사장 정책 2026-05-06.
                             샘플(외상=0)/반품(외상<0=매입금) 등은 빨간 X.
                             기존 "미처리/미송보류" 시각은 [미송]/[오더] 뱃지로 대체. */
                          !isPaid && (order.outstanding_amount ?? 0) > 0                 ? "border-gray-100 bg-red-100 hover:bg-red-100/80" :
                          order.is_sample                                                ? "border-gray-100 bg-amber-50/40 hover:bg-amber-50" :
                          "border-gray-100 hover:bg-gray-50"
                        }`}
                      >
                        <td className="px-2 py-1.5 text-center text-xs text-gray-400 cursor-pointer" onClick={() => selectOrder(order)}>{filteredOrders.length - i}</td>
                        <td className="px-2 py-1.5 text-center text-xs text-gray-600 whitespace-nowrap cursor-pointer" onClick={() => selectOrder(order)}>{formatOrderTime(order.receipt_issued_at ?? order.created_at)}</td>
                        <td className="px-2 py-1.5 text-xs font-medium text-gray-800 cursor-pointer max-w-[140px]" onClick={() => selectOrder(order)}>
                          <div className="flex items-center gap-1 flex-wrap">
                            <span className="truncate" title={order.customer_name ?? ""}>{order.customer_name ?? "-"}</span>
                            {order.is_sample && <ProcessBadge kind="샘플" />}
                            {order.order_source === "sample_convert" && <ProcessBadge kind="샘결" />}
                            {order.has_shipped && !order.is_sample && <ProcessBadge kind="출고" />}
                            {order.has_backorder && <ProcessBadge kind="미송" />}
                            {order.has_hold && <ProcessBadge kind="보류" />}
                          </div>
                        </td>
                        <td className="px-2 py-1.5 text-center text-xs cursor-pointer" onClick={() => selectOrder(order)}>
                          {(order.confirmed_qty ?? 0) === 0
                            ? <span className="text-gray-300">—</span>
                            : <span className={(order.confirmed_qty ?? 0) < 0 ? "text-rose-600 font-medium" : "text-gray-700"}>{order.confirmed_qty}</span>}
                        </td>
                        <td className="px-2 py-1.5 text-right text-xs font-medium cursor-pointer" onClick={() => selectOrder(order)}>
                          {(order.confirmed_amount ?? 0) === 0
                            ? <span className="text-gray-300">—</span>
                            : <span className={(order.confirmed_amount ?? 0) < 0 ? "text-rose-600" : "text-gray-900"}>{krw(order.confirmed_amount)}</span>}
                        </td>
                        <td className="px-2 py-1.5 text-right text-xs font-medium cursor-pointer" onClick={() => selectOrder(order)}>
                          {bal === 0 ? <span className="text-gray-300">—</span> : (
                            <span className={bal > 0 ? "text-red-500" : "text-primary-ring"}>{bal.toLocaleString()}</span>
                          )}
                        </td>
                        <td className="px-2 py-1.5 text-center text-xs">
                          {(() => {
                            const pm = customerPaymentMethods[order.customer_id] ?? "cash";
                            const cfg = pm === "cash" ? { label: "현금", cls: "text-green-700" }
                                      : pm === "transfer" ? { label: "통장", cls: "text-primary-hover" }
                                      : { label: "청구", cls: "text-purple-700" };
                            return <span className={`font-medium ${cfg.cls}`}>{cfg.label}</span>;
                          })()}
                        </td>
                        <td className="px-2 py-1.5 text-center">
                          {isPaid ? (
                            <span className="text-xs text-gray-400">결제완료</span>
                          ) : (
                            <div className="flex gap-0.5 justify-center">
                              {(["cash", "transfer"] as const).map(m => (
                                <button
                                  key={m}
                                  onClick={() => handleDayPayment(order, m)}
                                  disabled={isLoading || order.outstanding_amount <= 0 || !order.is_processed}
                                  className="px-1.5 py-0.5 text-xs font-medium rounded border transition-colors disabled:opacity-40 disabled:cursor-not-allowed bg-white text-gray-900 border-gray-300 hover:bg-gray-100"
                                >{METHOD_LABELS[m]}</button>
                              ))}
                              {bal < 0 && order.outstanding_amount > 0 && (
                                <button
                                  onClick={() => handlePurchaseCredit(order)}
                                  disabled={isLoading}
                                  className="px-1.5 py-0.5 text-xs font-medium rounded border transition-colors disabled:opacity-40 disabled:cursor-not-allowed bg-primary-soft text-primary border-primary-border hover:bg-primary-soft-hover"
                                >매입</button>
                              )}
                            </div>
                          )}
                        </td>
                        <td className="px-2 py-1.5 text-center">
                          <button
                            onClick={() => setPaymentForm(isFormOpen ? null : {
                              customerId: order.customer_id,
                              customerInput: order.customer_name ?? "",
                              processing: false,
                            })}
                            className={`px-1.5 py-0.5 text-xs font-medium rounded border transition-colors ${
                              isFormOpen ? METHOD_COLORS.credit.on : METHOD_COLORS.credit.off
                            }`}
                          >처리</button>
                        </td>
                      </tr>
                      </Fragment>
                    );
                  });
                  })()}
                </tbody>
              </DataTable>

              {/* "더보기" 버튼 — 영업세션 다중선택 안에서 300건 단위로 append. 처리 폼과 z-index 충돌 X (sticky bottom 아님). */}
              {totalCount > 0 && orders.length < totalCount && (
                <div className="flex justify-center py-3 border-t border-gray-100">
                  <button
                    type="button"
                    onClick={() => setPageOffset(p => p + RECEIPT_PAGE_SIZE)}
                    disabled={loadingOrders}
                    className="px-6 py-2 text-sm font-medium border border-gray-300 rounded-lg bg-white hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {loadingOrders
                      ? "불러오는 중..."
                      : `더보기 (${(totalCount - orders.length).toLocaleString()}건 남음)`}
                  </button>
                </div>
              )}

              {/* 입금처리 폼 — 공통 컴포넌트. sticky bottom-0 으로 viewport 바닥 유지. */}
              {paymentForm && (() => {
                const pm = customerPaymentMethods[paymentForm.customerId] ?? "cash";
                const includeVat = customerIncludeVat[paymentForm.customerId] ?? false;
                // 입금에 부가세 포함 여부 = 과세사업자(include_vat) AND 결제수단=청구.
                // 현금/통장은 입금 시 부가세 미포함 — 월말 부가세 정산에서 별도 입금받음.
                const vatInPayment = includeVat && pm === "credit";
                const pmLabel = METHOD_LABELS[pm] ?? pm;
                const pmColor = pm === "cash" ? "text-green-700" : pm === "transfer" ? "text-primary-hover" : "text-purple-700";
                return (
                  <div className="sticky bottom-0 z-20 bg-white">
                    <CustomerPaymentForm
                      customerName={paymentForm.customerInput}
                      customerVatDefault={vatInPayment}
                      paymentMethodLabel={pmLabel}
                      paymentMethodColorClass={pmColor}
                      processing={paymentForm.processing}
                      onCancel={() => setPaymentForm(null)}
                      onSubmit={data => handleCreditPayment(paymentForm.customerId, data)}
                    />
                  </div>
                );
              })()}
            </div>

            {/* 주문 상세.
                overflow-y-scroll + scrollbar-gutter:stable: viewport 작을 때 떨림 차단. */}
            <div className="flex flex-col flex-[8] min-w-0 min-h-0 overflow-y-scroll overflow-x-hidden [scrollbar-gutter:stable]">
              {selectedOrder ? (
                <div className="mb-2 shrink-0 flex items-center justify-between">
                  <div className="text-sm text-gray-600 min-w-0 truncate">
                    <span className="font-semibold text-gray-900">{selectedOrder.customer_name}</span>
                    <span className="ml-2 text-gray-400">{selectedOrder.order_number}</span>
                  </div>
                  <span className="text-sm font-bold text-gray-900 shrink-0">{krw(selectedOrder.total_amount - (selectedOrder.vat_amount ?? 0))}</span>
                </div>
              ) : (
                <div className="mb-2 shrink-0 h-7" />
              )}
              <DataTable maxHeight="none" className="flex-1 overflow-auto">
                <TableHead>
                  <Th>상품명</Th><Th>색상</Th><Th>사이즈</Th><Th>단가</Th><Th>수량</Th><Th>금액</Th><Th>처리수량</Th><Th></Th>
                </TableHead>
                <tbody>
                  {!selectedOrderId ? (
                    <EmptyRow colSpan={8} message="주문을 선택하면 상세 내용이 표시됩니다." />
                  ) : loadingItems ? (
                    <LoadingRow colSpan={8} />
                  ) : orderItems.length === 0 ? (
                    <EmptyRow colSpan={8} message="상품 내역이 없습니다." />
                  ) : orderItems.map(item => {
                    // 행별 표시 수량/금액 = 영수증 list confirmed_qty 와 동일 (박제 freeze):
                    //   미송 row 는 quantity (immutable 박제값), 일반 row 는 shipped_qty + (sample → quantity).
                    // 음수 표시: 반품 derived (return) + 미송해제 derived (backorder_release, 148)
                    const isNegative = selectedOrder?.order_source === "return"
                                    || selectedOrder?.order_source === "backorder_release";
                    const isBackorderRow = item.process_type === "backorder";
                    const isBackorderUnshipped = isBackorderRow && item.status === "unshipped";
                    const isHoldUnshipped      = item.process_type === "hold"      && item.status === "unshipped";
                    const shippedPart = (!item.is_sample && !isBackorderRow) ? (item.shipped_qty ?? 0) : 0;
                    const samplePart  = item.is_sample && item.process_type === "ordered" ? (item.quantity ?? 0) : 0;
                    // 박제 freeze: 미송 row quantity = immutable. 출고/해제로 remaining_qty 변동 무관.
                    const backorderPart = isBackorderRow ? (item.quantity ?? 0) : 0;
                    const rawQty = shippedPart + samplePart + backorderPart;
                    const displayQty = isNegative ? -rawQty : rawQty;
                    const displayAmt = displayQty * item.unit_price;
                    return (
                    <tr key={item.id} className="border-b border-gray-100 hover:bg-gray-50">
                      <td className="px-2 py-1.5 text-xs font-medium text-gray-800">
                        <div className="flex items-center gap-1 flex-wrap">
                          <span>{item.product_variants?.products?.name ?? "-"}</span>
                          {item.is_sample && <ProcessBadge kind="샘플" />}
                          {isBackorderUnshipped && !item.is_exchange && <ProcessBadge kind="미송" />}
                          {isBackorderUnshipped && item.is_exchange && <ProcessBadge kind="교환" />}
                          {isHoldUnshipped && <ProcessBadge kind="보류" />}
                        </div>
                      </td>
                      <td className="px-2 py-1.5 text-center text-xs text-gray-600">{item.product_variants?.color ?? "-"}</td>
                      <td className="px-2 py-1.5 text-center text-xs text-gray-600">{item.product_variants?.size ?? "-"}</td>
                      <td className="px-2 py-1.5 text-right text-xs text-gray-700">{krw(item.unit_price)}</td>
                      <td className="px-2 py-1.5 text-center text-xs font-medium text-gray-900">
                        {displayQty === 0
                          ? <span className="text-gray-300">—</span>
                          : <span className={displayQty < 0 ? "text-rose-600 font-medium" : ""}>{displayQty}</span>}
                      </td>
                      <td className="px-2 py-1.5 text-right text-xs font-medium text-gray-900">
                        {displayQty === 0
                          ? <span className="text-gray-300">—</span>
                          : <span className={displayAmt < 0 ? "text-rose-600" : ""}>{krw(displayAmt)}</span>}
                      </td>
                      <td className="px-2 py-1.5 text-center">
                        {/* 샘플 라인은 교환/반품 차단 (사장 모델: 샘플은 매출/외상 무관).
                            반품 가능 잔량 = shipped_qty - returned_qty (누적 반품량 차감)
                            음수 derived (반품/미송해제) 영수증의 라인은 반품 차단 (이미 반품/해제된 건). */}
                        {!isNegative && item.shipped_qty > 0 && item.process_type === "ordered" && !item.is_sample && (() => {
                          const remainable = (item.shipped_qty ?? 0) - (item.returned_qty ?? 0);
                          if (remainable <= 0) return <span className="text-[10px] text-gray-300">완료</span>;
                          return (
                            <div className="flex items-center justify-center gap-1">
                              <input
                                type="text" inputMode="numeric"
                                value={detailQtyInputs[item.id] ?? ""}
                                placeholder="0"
                                onChange={e => {
                                  const raw = e.target.value.replace(/[^0-9]/g, "");
                                  const num = parseInt(raw, 10);
                                  setDetailQtyInputs(prev => ({ ...prev, [item.id]: isNaN(num) ? "" : num.toLocaleString() }));
                                  setDetailErrorIds(prev => { const s = new Set(prev); s.delete(item.id); return s; });
                                }}
                                className={`w-12 px-1 py-0.5 border rounded text-xs text-center focus:outline-none focus:ring-1 focus:ring-primary-ring ${
                                  detailErrorIds.has(item.id) ? "border-orange-400 bg-orange-100" : "border-gray-300"
                                }`}
                              />
                              <span className="text-[10px] text-gray-400 whitespace-nowrap">/ {remainable}</span>
                            </div>
                          );
                        })()}
                      </td>
                      <td className="px-2 py-1.5 text-center">
                        {/* 반품/교환은 process_type='ordered' (일반 출고) + 비샘플 + 반품 가능 잔량 > 0 일 때만.
                            잔량 = shipped_qty - returned_qty (마이그 141 backend 검증과 동일 기준).
                            음수 derived 영수증 (반품/미송해제) 의 라인은 반품 차단. */}
                        {!isNegative && item.shipped_qty > 0 && item.process_type === "ordered" && !item.is_sample && (() => {
                          const remainable = (item.shipped_qty ?? 0) - (item.returned_qty ?? 0);
                          if (remainable <= 0) return null;
                          // 교환 버튼 비활성화 (사장 결정 2026-05-07): 기능이 반품과 동일.
                          // 필요 시 detailExchangeIds + handleDetailProcess 'exchange' 분기에 버튼만 다시 달면 됨.
                          return (
                            <div className="flex gap-1 justify-center">
                              <button
                                onClick={() => {
                                  const active = detailReturnIds.has(item.id);
                                  setDetailReturnIds(prev => { const s = new Set(prev); if (active) s.delete(item.id); else s.add(item.id); return s; });
                                  setDetailExchangeIds(prev => { const s = new Set(prev); s.delete(item.id); return s; });
                                  if (!active) setDetailQtyInputs(prev => ({ ...prev, [item.id]: prev[item.id] || remainable.toLocaleString() }));
                                }}
                                className={`px-2 py-0.5 text-xs font-medium rounded border transition-colors ${detailReturnIds.has(item.id) ? "bg-red-500 text-white border-red-500" : "bg-red-50 text-red-500 border-red-200 hover:bg-red-100"}`}
                              >반품</button>
                            </div>
                          );
                        })()}
                      </td>
                    </tr>
                  );
                  })}
                </tbody>
              </DataTable>

              {/* 영수증 상세 처리! 버튼 — 반품 토글 시 표시. (교환 비활성화 — 2026-05-07) */}
              {selectedOrderId && (() => {
                const total = detailReturnIds.size;
                if (total === 0) return null;
                return (
                  <div className="shrink-0 sticky bottom-0 z-20 bg-white flex justify-end items-center pt-2 pb-2 gap-2">
                    <span className="text-xs text-gray-500">반품 {detailReturnIds.size}</span>
                    <button
                      onClick={handleDetailProcess}
                      disabled={detailProcessing}
                      className={`px-6 py-2 text-sm font-bold rounded-lg shadow transition-colors ${
                        detailProcessing ? "bg-gray-100 text-gray-300 cursor-not-allowed" : "bg-primary text-white hover:bg-primary-hover"
                      }`}
                    >
                      {detailProcessing ? "처리 중..." : `처리! (${total}건)`}
                    </button>
                  </div>
                );
              })()}
            </div>

            {/* 영수증 미리보기 패널 */}
            <div className="flex flex-col flex-[5] min-w-0 min-h-0">
              <ReceiptInlinePanel orderId={selectedOrderId} />
            </div>
          </div>
          {/* orders-history 탭 페이지네이션 제거됨 */}
        </div>
      )}

      {/* 주문처리 탭 제거 — productPanel 은 sale 탭 우측에서만 사용 */}
      {/* 조회/반품 탭 제거 — 영수증 기준 탭 상세에서 통합 */}

      {/* 영수증 미리보기/출력 모달 */}
      {receiptModal && (
        <ReceiptPrintModal
          orderId={receiptModal.orderId}
          onClose={() => setReceiptModal(null)}
        />
      )}

      {pendingModal && (
        <PendingPrintModal
          mode={pendingModal}
          onClose={() => setPendingModal(null)}
        />
      )}

      </div>
      {/* 하단 풀폭 탭바 — 주문/입금처리 5:5 (관리자 요청 2026-05-11). */}
      <div className="shrink-0 border-t border-gray-200 bg-white">
        {tabButtons}
      </div>
    </div>
  );
}

export default function OrdersPage() {
  return <Suspense><OrdersPageInner /></Suspense>;
}
