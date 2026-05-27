"use client";

import { useEffect, useState, useRef, useMemo } from "react";
import { supabase } from "@/lib/supabase";
import { krw, METHOD_LABELS, displayOutstanding } from "@/lib/format";
import { generateOrderNumber } from "@/lib/orderNumber";
import { getBizSessionId, ensureBizOpen, bizReset } from "@/lib/bizSession";
import type { Customer as FullCustomer } from "@/lib/types";
import { buildReceiptDoc } from "./receipt/template";
import { ReceiptPreview } from "./receipt/ReceiptPreview";
import { ReceiptPrintModal } from "./receipt/ReceiptPrintModal";
import type { ReceiptData } from "./receipt/types";
import CustomerModal from "./CustomerModal";
import ProductModal from "./ProductModal";
import Button from "./Button";
import { INPUT_MD } from "./DataTable";

type Customer = Pick<FullCustomer, "id" | "company_name" | "outstanding_balance" | "outstanding_vat" | "credit_limit" | "include_vat" | "default_payment_method" | "region" | "business_form">;

type VariantRow = {
  variant_id: string;
  product_id: string;
  product_name: string;
  category: string;
  color: string;
  size: string;
  base_price: number;
  stock: number;
  is_sale: boolean;
};

type OrderItem = {
  variant_id: string;
  product_name: string;
  color: string;
  size: string;
  stock: number;
  qty: number;
  price: number;
};

type CustomerPrice = { variant_id: string; negotiated_price: number };

export type SavedOrder = {
  id: string;
  order_number: string;
  customer_name: string;
  total_amount: number;
  vat_amount: number;
};

type Props = {
  tenantId: string;
  tenantCode: string;
  onSaveSuccess: (order: SavedOrder) => void;
  /** true 면 중앙 카테고리/상품 그리드 + 우측 영수증 미리보기 영역 hide. 좌측 입력만 표시. */
  compact?: boolean;
};

export default function SaleForm({ tenantId, tenantCode, onSaveSuccess, compact = false }: Props) {
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [customerSearch, setCustomerSearch] = useState("");
  const [showCustomerModal, setShowCustomerModal] = useState(false);
  // 거래처 수정 — 드롭다운 [수정] 버튼 클릭 시 채워짐. null 이면 신규 등록.
  const [editingCustomer, setEditingCustomer] = useState<FullCustomer | null>(null);
  // 키보드 ↑↓ 네비게이션 — 거래처/상품 드롭다운 highlight index. -1 = 미선택.
  const [customerHighlight, setCustomerHighlight] = useState(-1);
  const [productHighlight,  setProductHighlight]  = useState(-1);
  const customerOptionRefs = useRef<Map<string, HTMLElement>>(new Map());
  const productOptionRefs  = useRef<Map<string, HTMLElement>>(new Map());
  const [showProductModal, setShowProductModal]   = useState(false);
  const [showCustomerDrop, setShowCustomerDrop] = useState(false);
  const [selectedCustomer, setSelectedCustomer] = useState<Customer | null>(null);
  const [customerPrices, setCustomerPrices] = useState<CustomerPrice[]>([]);
  const customerRef = useRef<HTMLDivElement>(null);
  const customerInputRef = useRef<HTMLInputElement>(null);
  const productInputRef  = useRef<HTMLInputElement>(null);

  const [allVariants, setAllVariants] = useState<VariantRow[]>([]);
  const [productCategories, setProductCategories] = useState<string[]>([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [showSearchDrop, setShowSearchDrop] = useState(false);
  const searchRef = useRef<HTMLDivElement>(null);
  const [activeProductId, setActiveProductId] = useState<string | null>(null);
  const [activeCategory, setActiveCategory] = useState("전체");

  const [items, setItems] = useState<OrderItem[]>([]);
  const [saving, setSaving] = useState(false);
  const [vatEnabled, setVatEnabled] = useState(false);
  const [vatRate, setVatRate] = useState(0.10); // tenants.vat_rate (default 10%)
  const [savedOrder, setSavedOrder] = useState<SavedOrder | null>(null);

  // 영수증 미리보기 — 입력 중 실시간 표시. 저장 시 버튼 분기로 출력.
  const [tenantBiz, setTenantBiz] = useState<{
    company_name: string;
    business_number: string | null;
    owner_name: string | null;
    phone: string | null;
    address: string | null;
  } | null>(null);
  const [showPrintModal, setShowPrintModal] = useState(false);

  useEffect(() => {
    fetchCustomers();
    fetchVariantsWithStock();
    fetchProductCategories();
    fetchTenantBiz();
  }, [tenantId]); // eslint-disable-line react-hooks/exhaustive-deps

  async function fetchTenantBiz() {
    const { data } = await supabase
      .from("tenants")
      .select("company_name, business_number, owner_name, phone, address, biz_address, vat_rate")
      .eq("id", tenantId)
      .maybeSingle();
    if (data) {
      setTenantBiz({
        company_name:    data.company_name,
        business_number: data.business_number ?? null,
        owner_name:      data.owner_name ?? null,
        phone:           data.phone ?? null,
        address:         data.biz_address ?? data.address ?? null,
      });
      setVatRate(Number(data.vat_rate ?? 0.10));
    }
  }

  // vatEnabled — payment_method 종속 (관리자 정책 2026-05-11): credit 만 vat 포함.
  // customer.include_vat 무시 (DB 박제는 CustomerModal 저장 시 자동 sync).
  useEffect(() => {
    setVatEnabled(selectedCustomer?.default_payment_method === "credit");
  }, [selectedCustomer?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (customerRef.current && !customerRef.current.contains(e.target as Node))
        setShowCustomerDrop(false);
      if (searchRef.current && !searchRef.current.contains(e.target as Node))
        setShowSearchDrop(false);
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

  // 단축키 — Alt 조합 (브라우저 기본 동작 충돌 회피, 입력창 포커스 중에도 동작)
  // ref 패턴으로 매 렌더 최신 handleSave 참조 보장.
  // 4모드: sample(샘플요청등록) / sample-immediate(샘플즉시처리) / order(주문등록) / order-immediate(주문즉시처리)
  const shortcutsRef = useRef<{
    save: (mode: "order" | "sample" | "order-immediate" | "sample-immediate") => void;
    saving: boolean;
  }>({ save: () => {}, saving: false });
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (!e.altKey || e.ctrlKey || e.metaKey) return;
      const k = e.key.toLowerCase();
      const { save, saving } = shortcutsRef.current;
      if (saving) return;
      switch (k) {
        case "s": e.preventDefault(); save("order");             break;
        case "d": e.preventDefault(); save("order-immediate");   break;
        case "e": e.preventDefault(); save("sample");            break;
        case "r": e.preventDefault(); save("sample-immediate");  break;
        case "c": e.preventDefault(); customerInputRef.current?.focus(); break;
        case "i": e.preventDefault(); productInputRef.current?.focus();  break;
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  // shortcutsRef 매 렌더마다 최신 handleSave/saving 동기화
  useEffect(() => {
    shortcutsRef.current = { save: handleSave, saving };
  });

  async function fetchCustomers() {
    const { data } = await supabase.from("customers")
      .select("id, company_name, outstanding_balance, outstanding_vat, credit_limit, include_vat, default_payment_method, region, business_form")
      .eq("tenant_id", tenantId).eq("is_active", true).order("company_name");
    if (data) setCustomers(data);
  }

  async function fetchProductCategories() {
    const { data } = await supabase.from("product_categories")
      .select("name").eq("tenant_id", tenantId).order("name");
    if (data) setProductCategories(data.map(c => c.name));
  }

  async function fetchVariantsWithStock() {
    // 신규 주문 폼: 품절(variant.is_active=false) 옵션 / 품절 상품(products.is_active=false) 노출 차단.
    // 기존 주문/처리는 영향 X — 이미 등록된 주문은 보호됨.
    // 가격: variant.is_sale=true → products.sale_price, 아니면 base_price (옵션 단위 운영)
    const [{ data: variantData }, { data: invData }] = await Promise.all([
      supabase.from("product_variants")
        .select("id, color, size, product_id, is_active, is_sale, products!inner(name, base_price, category, is_active, sale_price)")
        .eq("products.tenant_id", tenantId)
        .eq("is_active", true)              // variant 활성만
        .eq("products.is_active", true)     // product 도 활성만
        .order("product_id"),
      supabase.from("inventory").select("variant_id, quantity").eq("tenant_id", tenantId),
    ]);
    const stockMap: Record<string, number> = {};
    invData?.forEach(r => { stockMap[r.variant_id] = r.quantity; });
    if (variantData) {
      setAllVariants(variantData.map(v => {
        const vv = v as unknown as { is_sale: boolean };
        const p = v.products as unknown as { name: string; base_price: number; category: string | null; sale_price: number | null } | null;
        const basePrice = (vv.is_sale && p?.sale_price) ? p.sale_price : (p?.base_price || 0);
        return {
          variant_id: v.id, product_id: v.product_id,
          product_name: p?.name || "-",
          category: p?.category || "기타",
          color: v.color || "-", size: v.size || "-",
          base_price: basePrice, stock: stockMap[v.id] || 0,
          is_sale: !!vv.is_sale,
        };
      }));
    }
  }

  // 드롭다운 [수정] 버튼 — 거래처 전체 row 가져와서 CustomerModal editing 으로 전달.
  async function openEditCustomer(c: Customer) {
    const { data, error } = await supabase.from("customers").select("*").eq("id", c.id).single();
    if (error || !data) { alert("거래처 정보 조회 실패: " + (error?.message ?? "없음")); return; }
    setEditingCustomer(data as FullCustomer);
    setShowCustomerModal(true);
  }

  async function selectCustomer(c: Customer) {
    setSelectedCustomer(c);
    // 거래처 선택 후 input 자동 초기화 — 다시 검색 시 새 거래처 선택 가능. X 버튼 대체.
    setCustomerSearch("");
    setShowCustomerDrop(false);
    const { data } = await supabase.from("product_customer_prices")
      .select("variant_id, negotiated_price").eq("customer_id", c.id);
    setCustomerPrices(data || []);
  }

  function clearCustomer() {
    setSelectedCustomer(null);
    setCustomerSearch("");
    setCustomerPrices([]);
  }

  function getPrice(variantId: string, basePrice: number) {
    const cp = customerPrices.find(p => p.variant_id === variantId);
    return cp ? cp.negotiated_price : basePrice;
  }

  function addVariant(v: VariantRow, keepOpen = false) {
    const price = getPrice(v.variant_id, v.base_price);
    setItems(prev => [...prev, {
      variant_id: v.variant_id, product_name: v.product_name,
      color: v.color, size: v.size, stock: v.stock,
      qty: 1, price,
    }]);
    if (!keepOpen) {
      setSearchQuery("");
      setShowSearchDrop(false);
    }
  }

  function updateQty(index: number, qty: number) {
    setItems(prev => prev.map((it, i) => i === index ? { ...it, qty } : it));
  }

  function updatePrice(index: number, price: number) {
    setItems(prev => prev.map((it, i) => i === index ? { ...it, price } : it));
  }

  function removeItem(index: number) {
    setItems(prev => prev.filter((_, i) => i !== index));
  }

  const categories = useMemo(() => {
    const managed = productCategories.length > 0
      ? productCategories
      : [...new Set(allVariants.map(v => v.category))].filter(c => c && c !== "기타").sort();
    return ["전체", ...managed];
  }, [productCategories, allVariants]);

  // 검색어 있으면 자동완성 필터, 없으면 전체 진행/세일 상품 (포커스 시 자동 드롭다운).
  // 빈 쿼리 시 일반 → 세일 순 정렬 (세일은 하단 모음).
  const searchResults = useMemo(() => searchQuery.trim()
    ? allVariants.filter(v =>
        v.product_name.includes(searchQuery) || v.color.includes(searchQuery) || v.size.includes(searchQuery)
      ).slice(0, 20)
    : [...allVariants].sort((a, b) => {
        if (a.is_sale !== b.is_sale) return a.is_sale ? 1 : -1;
        return a.product_name.localeCompare(b.product_name, "ko");
      }),
  [allVariants, searchQuery]);

  // 거래처 매칭 — 드롭다운 + 키보드 네비게이션 공유.
  const customerMatches = useMemo(() => {
    const q = customerSearch.trim();
    return q ? customers.filter(c => c.company_name.includes(q)) : customers;
  }, [customers, customerSearch]);

  // 검색어/드롭다운 표시 변경 시 highlight reset.
  useEffect(() => { setCustomerHighlight(customerMatches.length > 0 ? 0 : -1); }, [customerSearch, showCustomerDrop, customerMatches.length]);
  useEffect(() => { setProductHighlight(searchResults.length > 0 ? 0 : -1); }, [searchQuery, showSearchDrop, searchResults.length]);

  // highlighted 항목 시야 자동 스크롤.
  useEffect(() => {
    if (customerHighlight < 0) return;
    const c = customerMatches[customerHighlight];
    if (c) customerOptionRefs.current.get(c.id)?.scrollIntoView({ block: "nearest" });
  }, [customerHighlight, customerMatches]);
  useEffect(() => {
    if (productHighlight < 0) return;
    const v = searchResults[productHighlight];
    if (v) productOptionRefs.current.get(v.variant_id)?.scrollIntoView({ block: "nearest" });
  }, [productHighlight, searchResults]);

  const gridProducts = useMemo(() => {
    const base = activeCategory === "전체" ? allVariants : allVariants.filter(v => v.category === activeCategory);
    return Array.from(
      base.reduce((map, r) => {
        if (!map.has(r.product_id)) map.set(r.product_id, r);
        return map;
      }, new Map<string, VariantRow>()).values()
    );
  }, [allVariants, activeCategory]);

  const activeVariants = activeProductId ? allVariants.filter(v => v.product_id === activeProductId) : [];

  const supply = items.reduce((s, i) => s + i.qty * i.price, 0);
  const vat = vatEnabled ? Math.round(supply * vatRate) : 0;
  const total = supply + vat;

  // 실시간 영수증 도큐먼트 — 입력값 변할 때마다 갱신
  const previewDoc = useMemo(() => {
    const now = new Date();
    const kst = new Date(now.getTime() + 9 * 3600 * 1000);
    const orderDate = `${kst.getUTCFullYear()}-${String(kst.getUTCMonth()+1).padStart(2,"0")}-${String(kst.getUTCDate()).padStart(2,"0")} ${String(kst.getUTCHours()).padStart(2,"0")}:${String(kst.getUTCMinutes()).padStart(2,"0")}`;
    const yy = String(kst.getUTCFullYear()).slice(-2);
    const wd = ["일","월","화","수","목","금","토"][kst.getUTCDay()];
    const shipDate = `${yy}-${String(kst.getUTCMonth()+1).padStart(2,"0")}-${String(kst.getUTCDate()).padStart(2,"0")}(${wd})`;
    const pmKey = (selectedCustomer?.default_payment_method ?? "cash") as "cash" | "transfer" | "credit";
    const pmLabel = METHOD_LABELS[pmKey] ?? pmKey;
    const data: ReceiptData = {
      businessName:   tenantBiz?.company_name ?? "(사업자정보 미입력)",
      businessNumber: tenantBiz?.business_number ?? null,
      ceoName:        tenantBiz?.owner_name ?? null,
      phone:          tenantBiz?.phone ?? null,
      address:        tenantBiz?.address ?? null,
      orderNumber:    savedOrder?.order_number ?? "(미저장)",
      orderDate,
      shipDate,
      customerName:   selectedCustomer?.company_name ?? "(거래처 미선택)",
      paymentMethod:  pmLabel,
      paymentMethodKey: pmKey,
      items: items.map(it => ({
        name:      it.product_name,
        qty:       it.qty,
        unitPrice: it.price,
        amount:    it.qty * it.price,
        option:    [it.color, it.size].filter(Boolean).join(" ") || undefined,
      })),
      supply,
      vat,
      total,
      vatInPayment:   vatEnabled, // 159 미리보기 — 박제 전이라 toggle 직접 사용
      outstanding:    selectedCustomer ? displayOutstanding(selectedCustomer) : 0,
      memo:           null,
    };
    return buildReceiptDoc(data);
  }, [tenantBiz, selectedCustomer, items, supply, vat, total, vatEnabled, savedOrder]);

  async function handleSave(
    mode: "order" | "sample" | "order-immediate" | "sample-immediate" = "order",
  ) {
    if (!ensureBizOpen()) return;
    if (!selectedCustomer) return alert("거래처를 선택해주세요.");
    if (items.length === 0) return alert("상품을 추가해주세요.");

    // biz_session DB 검증 — localStorage stale 방지 (예: DB 리셋 후 캐시 잔재).
    // FK 위반 ("orders_biz_session_id_fkey") 사전 차단.
    const sessionId = getBizSessionId();
    if (sessionId) {
      const { data: sessionRow } = await supabase
        .from("biz_sessions")
        .select("id")
        .eq("id", sessionId)
        .maybeSingle();
      if (!sessionRow) {
        bizReset();
        alert("영업세션이 만료/삭제되었습니다.\n영업개시를 다시 진행해주세요.");
        return;
      }
    }
    const isSampleOrder      = mode === "sample" || mode === "sample-immediate";
    const isOrderImmediate   = mode === "order-immediate";
    const isSampleImmediate  = mode === "sample-immediate";
    const isImmediate        = isOrderImmediate || isSampleImmediate;

    // 즉시처리: 사전 재고 검증 (variant 단위 합계 vs 재고)
    if (isImmediate) {
      const needByVariant = new Map<string, number>();
      for (const it of items) {
        needByVariant.set(it.variant_id, (needByVariant.get(it.variant_id) ?? 0) + it.qty);
      }
      const variantIds = Array.from(needByVariant.keys());
      const { data: invData } = await supabase
        .from("inventory")
        .select("variant_id, quantity")
        .eq("tenant_id", tenantId)
        .in("variant_id", variantIds);
      const invMap = new Map((invData ?? []).map(r => [r.variant_id, r.quantity]));
      const insufficient = variantIds.filter(vid => (invMap.get(vid) ?? 0) < (needByVariant.get(vid) ?? 0));
      if (insufficient.length > 0) {
        alert("재고가 부족한 옵션이 있습니다. 일반 [주문 등록] 후 처리해주세요.");
        return;
      }
    }

    setSaving(true);
    const orderNumber = await generateOrderNumber(tenantId, tenantCode);
    // 결제수단: 거래처 default 자동 (즉시처리 시에도 동일). 변경하려면 거래처 수정.
    const paymentMethod = selectedCustomer.default_payment_method ?? "cash";

    const { data: order, error } = await supabase.from("orders").insert({
      tenant_id: tenantId,
      customer_id: selectedCustomer.id,
      customer_name: selectedCustomer.company_name,
      payment_method: paymentMethod,
      order_number: orderNumber,
      order_type: "wholesale",
      order_source: "internal",
      status: "confirmed",
      total_amount: isSampleOrder ? 0 : total,
      vat_amount: isSampleOrder ? 0 : vat,
      paid_amount: 0,
      outstanding_amount: 0,
      biz_session_id: getBizSessionId(),
    }).select("id").single();

    if (error) { alert(error.message); setSaving(false); return; }

    const { error: itemsError } = await supabase.from("order_items").insert(
      items.map(item => ({
        order_id: order.id,
        variant_id: item.variant_id,
        quantity: item.qty,
        original_quantity: item.qty,
        remaining_qty: item.qty,
        unit_price: item.price,
        total_price: item.qty * item.price,
        status: "unshipped",
        process_type: "ordered",
        is_sample: isSampleOrder,
        sample_status: null,
        sample_due_date: null,
      }))
    );

    if (itemsError) {
      await supabase.from("orders").delete().eq("id", order.id);
      setSaving(false);
      alert("상품 등록 실패: " + itemsError.message);
      return;
    }

    // 즉시처리 = 처리화면 [당일]+[처리!] 흐름 자동 호출 (처리화면과 100% 동일 RPC).
    //   주문즉시처리 → process_register_action(shipment) → derived 영수증 박제. cash/transfer 면 즉시 입금.
    //   샘플즉시처리 → process_register_action(shipment) 동일 호출. 결제 단계만 SKIP (샘플은 무결제).
    //                  ※ 정책 모순 알림 — RPC 가 is_sample 라인도 매출/외상 박제. 처리화면 [당일]+[처리!] 도 동일.
    //                    사장 정책 ("샘플 매출 X") 과 모순. 마이그 169 (process_register_action is_sample 분기) 필요 검토.
    let derivedOrderId: string | null = null;
    if (isImmediate) {
      const { data: insertedItems } = await supabase
        .from("order_items")
        .select("id, quantity")
        .eq("order_id", order.id);
      try {
        const actions = [{
          kind: "shipment",
          items: (insertedItems ?? []).map(it => ({ item_id: it.id, qty: it.quantity })),
        }];
        const { data: actionResult, error: actionErr } = await supabase.rpc("process_register_action", {
          p_tenant_id:         tenantId,
          p_customer_id:       selectedCustomer.id,
          p_staging_order_ids: [order.id],
          p_actions:           actions,
        });
        if (actionErr) throw new Error(actionErr.message);
        const result = actionResult as { success: boolean; combined_order_id: string | null; hold_order_id: string | null; error?: string };
        if (!result?.success) throw new Error(result?.error ?? "처리 실패");
        derivedOrderId = result.combined_order_id ?? null;

        // 주문즉시처리 + cash/transfer 거래처 → 즉시 입금 박제. 샘플즉시처리는 결제 SKIP.
        // 매입금 자동 충당된 만큼은 process_register_action 안에서 이미 결제됨 → 남은 잔액만 결제.
        // (사장 보고 2026-05-12: 173 적용 후에도 매입금 보유 cash 거래처에 total 결제 → 충당분 상쇄로 매입금 그대로)
        if (isOrderImmediate && derivedOrderId && (paymentMethod === "cash" || paymentMethod === "transfer")) {
          const { data: orderAfter } = await supabase
            .from("orders")
            .select("total_amount, paid_amount, vat_amount")
            .eq("id", derivedOrderId)
            .single();
          const totalAmt = orderAfter?.total_amount ?? total;
          const paidAmt  = orderAfter?.paid_amount ?? 0;
          const vatAmt   = orderAfter?.vat_amount ?? 0;
          const remaining = Math.max(0, totalAmt - paidAmt);
          if (remaining > 0) {
            // vat 비례 분배 (자동 충당이 supply 만 paid_amount 누적 → vat 는 그대로 남음)
            const remainingVat = totalAmt > 0 ? Math.round(vatAmt * remaining / totalAmt) : 0;
            const { error: pErr } = await supabase.rpc("process_payment", {
              p_tenant_id:   tenantId,
              p_customer_id: selectedCustomer.id,
              p_amount:      remaining,
              p_method:      paymentMethod,
              p_source:      "payment",
              p_order_id:    derivedOrderId,
              p_vat_mode:    vatEnabled ? "included" : "none",
              p_vat_amount:  remainingVat,
            });
            if (pErr) throw new Error(pErr.message);
          }
        }
      } catch (e) {
        setSaving(false);
        const label = isSampleImmediate ? "샘플즉시처리" : "주문즉시처리";
        alert(`${label} 오류: ${(e as Error).message}\n\n주문은 등록됨. 주문/매출 관리에서 수동 처리해주세요.`);
        const saved = { id: order.id, order_number: orderNumber, customer_name: selectedCustomer.company_name, total_amount: isSampleOrder ? 0 : total, vat_amount: isSampleOrder ? 0 : vat };
        if (compact) { resetForm(); onSaveSuccess(saved); } else { setSavedOrder(saved); }
        return;
      }
    }

    setSaving(false);
    // 주문즉시처리 정상 케이스: derivedOrderId (박제된 영수증 주문).
    // 일반 등록 / 샘플즉시처리: order.id (staging — 샘플즉시는 staging 자체가 처리완료 상태).
    const savedTotal = isSampleOrder ? 0 : total;
    const savedVat   = isSampleOrder ? 0 : vat;
    const saved = { id: derivedOrderId ?? order.id, order_number: orderNumber, customer_name: selectedCustomer.company_name, total_amount: savedTotal, vat_amount: savedVat };
    if (compact) {
      // compact 모드: 인라인 저장-완료 UI 안 띄우고 즉시 폼 초기화 + 부모 콜백 호출
      resetForm();
      onSaveSuccess(saved);
    } else {
      setSavedOrder(saved);
    }
  }

  function resetForm() {
    setSelectedCustomer(null);
    setCustomerSearch("");
    setCustomerPrices([]);
    setItems([]);
    setVatEnabled(false);
    setActiveProductId(null);
    setSavedOrder(null);
  }

  return (
    <div className="flex flex-1 min-h-0">

      {/* 왼쪽: 입력 영역 (4:4:2 — 출고목록/주문등록).
          overflow-y-auto: viewport 작을 때 컬럼 자체 스크롤 → 하단 합계/등록 띠가 sticky bottom-0 으로 viewport 바닥 유지.
          overflow-x-hidden: 가로 스크롤 발생 차단 (CSS 스펙상 y 만 auto 면 x 도 자동 auto 됨). */}
      <div className="flex flex-col flex-[4] min-w-0 border-r border-gray-200 overflow-y-auto overflow-x-hidden">

        {/* 주문 항목 — 입력 영역 위로 이동. 빈 공간이 상단을 차지. */}
        <div className="flex-1 overflow-y-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b border-gray-200 sticky top-0 z-10">
              <tr>
                <th className="text-center px-3 py-2 text-xs text-gray-500 font-medium">상품</th>
                <th className="text-center px-2 py-2 text-xs text-gray-500 font-medium">색상</th>
                <th className="text-center px-2 py-2 text-xs text-gray-500 font-medium">사이즈</th>
                <th className="text-center px-2 py-2 text-xs text-gray-500 font-medium w-24">단가</th>
                <th className="text-center px-2 py-2 text-xs text-gray-500 font-medium w-16">수량</th>
                <th className="text-center px-3 py-2 text-xs text-gray-500 font-medium">금액</th>
                <th className="w-6"></th>
              </tr>
            </thead>
            <tbody>
              {items.length === 0 ? (
                <tr>
                  <td colSpan={7} className="text-center py-16 text-gray-300 text-sm">
                    상품을 검색하거나 오른쪽 그리드에서 추가하세요
                  </td>
                </tr>
              ) : items.map((item, i) => (
                <tr key={`${item.variant_id}-${i}`} className="border-b border-gray-100 hover:bg-gray-50">
                  <td className="px-3 py-2 text-center font-medium text-gray-800 text-xs">{item.product_name}</td>
                  <td className="px-2 py-2 text-center text-gray-600 text-xs">{item.color}</td>
                  <td className="px-2 py-2 text-center text-gray-600 text-xs">{item.size}</td>
                  <td className="px-2 py-2 text-center">
                    <input type="number" min={0} value={item.price}
                      onChange={e => updatePrice(i, Number(e.target.value))}
                      className="w-20 text-center px-1 py-1 border border-gray-300 rounded text-xs focus:outline-none focus:ring-1 focus:ring-primary-ring" />
                  </td>
                  <td className="px-2 py-2 text-center">
                    <input type="number" min={1} value={item.qty}
                      onChange={e => updateQty(i, Math.max(1, Number(e.target.value)))}
                      className="w-14 text-center px-1 py-1 border border-gray-300 rounded text-xs focus:outline-none focus:ring-1 focus:ring-primary-ring" />
                  </td>
                  <td className="px-3 py-2 text-center text-xs font-medium text-gray-900">
                    {krw(item.qty * item.price)}
                  </td>
                  <td className="px-1 py-2 text-center">
                    <button onClick={() => removeItem(i)} className="text-gray-300 hover:text-red-400 text-base leading-none">×</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* 합계 / 저장 완료 UI — 검색 위. (이전 합계+4버튼 묶음에서 분리: 4버튼만 맨 아래로) */}
        <div className="border-t border-gray-200 bg-gray-50 px-4 py-3 shrink-0">
          {savedOrder ? (
            <div className="flex items-center justify-between">
              <div className="text-sm">
                <span className="text-green-600 font-semibold">✓ 등록 완료</span>
                <span className="ml-2 text-gray-500 text-xs">{savedOrder.order_number} · {krw(savedOrder.total_amount)}</span>
              </div>
              <div className="flex gap-2">
                <Button onClick={() => setShowPrintModal(true)}>영수증 출력</Button>
                <Button variant="secondary" onClick={resetForm}>다음 주문</Button>
                <Button variant="secondary" onClick={() => onSaveSuccess(savedOrder)}>완료</Button>
              </div>
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-2 min-w-0 items-start">
              {/* 좌측 cell — 거래처 정보. [초기화] 는 행2 의 우측 끝 = 중앙선 좌측. */}
              <div className="text-sm flex flex-col gap-1 min-w-0">
                {selectedCustomer ? (() => {
                  const BF_LABEL: Record<string, string> = { online: "온라인", offline: "오프라인", etc: "기타" };
                  const meta = [
                    selectedCustomer.region,
                    selectedCustomer.business_form ? BF_LABEL[selectedCustomer.business_form] : null,
                    METHOD_LABELS[selectedCustomer.default_payment_method] ?? null,
                  ].filter(Boolean).join(" · ");
                  return (
                    <>
                      {/* 행1: 거래처명 가로 꽉 — truncate 로 너무 길면 잘림 */}
                      <span className="text-lg font-semibold text-gray-800 truncate w-full">{selectedCustomer.company_name}</span>
                      {/* 행2: 좌측 (메타+vat) + 우측 [초기화] — flex justify-between */}
                      <div className="flex justify-between items-start gap-2">
                        <div className="flex flex-col min-w-0 flex-1">
                          <span className="text-xs text-gray-500 truncate">{meta || "—"}</span>
                          <span className="text-xs text-gray-500">{vatEnabled ? "결제시 부가세 포함" : "결제시 부가세 제외"}</span>
                        </div>
                        <button onClick={resetForm}
                          disabled={saving}
                          className="px-3 py-1.5 text-xs font-medium text-gray-600 border border-gray-300 bg-white rounded hover:bg-gray-50 active:bg-gray-100 disabled:opacity-40 disabled:cursor-not-allowed transition-colors shrink-0 self-start">
                          초기화
                        </button>
                      </div>
                    </>
                  );
                })() : (
                  <div className="text-xs text-gray-300">거래처 미선택</div>
                )}
              </div>
              {/* 우측 cell — 공급가/부가세/합계. justify-start 로 cell 좌측 시작 = 중앙선 우측에 붙음. */}
              <div className="flex justify-start pl-1 min-w-0">
                <div className="inline-grid grid-cols-[3rem_2.5rem_110px] gap-x-4 gap-y-0.5 items-center text-sm">
                  <span className="text-gray-500 text-right">공급가</span>
                  <span></span>
                  <span className="block font-semibold text-gray-800 tabular-nums text-right">{krw(supply)}</span>

                  <span className="text-gray-500 text-right">부가세</span>
                  <span></span>
                  <span className={`block font-medium tabular-nums text-right ${vatEnabled ? "text-primary" : "text-gray-300"}`}>{krw(vat)}</span>

                  <div className="col-span-3 border-t border-gray-200 mt-0.5"></div>

                  <span className="text-gray-700 font-semibold text-right">합&nbsp;&nbsp;&nbsp;&nbsp;계</span>
                  <span></span>
                  <span className="block font-bold text-gray-900 tabular-nums text-right">{krw(total)}</span>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* 거래처 + 상품 — 한 row 양옆 (좌: 거래처, 우: 상품). 각 영역 안에 input + 버튼 + 드롭다운. */}
        <div className="px-4 py-2.5 border-b border-gray-100 bg-gray-50 shrink-0 flex gap-2">
          {/* 거래처 */}
          <div className="relative flex-1 min-w-0" ref={customerRef}>
            <div className="flex gap-1.5">
              <input type="text" ref={customerInputRef} value={customerSearch}
                onChange={e => {
                  setCustomerSearch(e.target.value);
                  setShowCustomerDrop(true);
                  if (selectedCustomer) { clearCustomer(); setCustomerSearch(e.target.value); }
                }}
                onFocus={() => setShowCustomerDrop(true)}
                onKeyDown={e => {
                  if (!showCustomerDrop || selectedCustomer) return;
                  if (e.key === "ArrowDown") {
                    e.preventDefault();
                    setCustomerHighlight(h => Math.min(h + 1, customerMatches.length - 1));
                  } else if (e.key === "ArrowUp") {
                    e.preventDefault();
                    setCustomerHighlight(h => Math.max(h - 1, 0));
                  } else if (e.key === "Enter") {
                    if (customerHighlight >= 0 && customerHighlight < customerMatches.length) {
                      e.preventDefault();
                      selectCustomer(customerMatches[customerHighlight]);
                    }
                  } else if (e.key === "Escape") {
                    setShowCustomerDrop(false);
                  }
                }}
                placeholder="거래처 검색... (Alt+C)"
                className={`flex-1 min-w-0 ${INPUT_MD}`} />
              <button
                onMouseDown={e => { e.preventDefault(); setShowCustomerModal(true); }}
                className="px-3 py-1.5 text-xs font-semibold text-primary border border-primary-border rounded hover:bg-primary-soft whitespace-nowrap shrink-0"
              >+ 신규</button>
            </div>
            {showCustomerDrop && !selectedCustomer && (() => {
              const BF_LABEL: Record<string, string> = { online: "온라인", offline: "오프라인", etc: "기타" };
              return (
                <div className="absolute bottom-full mb-1 bg-white border border-gray-200 rounded-lg shadow-lg z-50 max-h-60 overflow-y-auto"
                  style={{ left: 0, right: "calc(-100% - 0.5rem)" }}>
                  {customerMatches.length === 0 ? (
                    <div className="px-4 py-3 text-sm text-gray-400 text-center">검색 결과 없음 — 우측 [신규 등록] 버튼으로 추가하세요</div>
                  ) : (
                    customerMatches.map((c, idx) => {
                      const middleParts = [
                        c.region,
                        METHOD_LABELS[c.default_payment_method] ?? null,
                        c.business_form ? BF_LABEL[c.business_form] : null,
                      ].filter(Boolean);
                      const isHl = idx === customerHighlight;
                      return (
                        <div key={c.id}
                          ref={el => { if (el) customerOptionRefs.current.set(c.id, el); else customerOptionRefs.current.delete(c.id); }}
                          onMouseEnter={() => setCustomerHighlight(idx)}
                          className={`px-4 py-2.5 text-sm grid grid-cols-[1fr_auto_auto] gap-3 items-center ${isHl ? "bg-primary-soft" : "hover:bg-primary-soft"}`}>
                          <button onClick={() => selectCustomer(c)} className="text-left truncate">
                            <span className="font-medium text-gray-800 truncate">{c.company_name}</span>
                          </button>
                          <button onClick={() => selectCustomer(c)} className="text-xs text-gray-500 truncate text-right max-w-[180px]">
                            {middleParts.join(" · ")}
                          </button>
                          <button
                            onMouseDown={e => { e.preventDefault(); openEditCustomer(c); }}
                            className="px-3 py-1.5 text-xs font-semibold text-primary border border-primary-border rounded hover:bg-primary-soft-hover whitespace-nowrap shrink-0">
                            수정
                          </button>
                        </div>
                      );
                    })
                  )}
                </div>
              );
            })()}
          </div>

          {/* 상품 */}
          <div className="relative flex-1 min-w-0" ref={searchRef}>
            <div className="flex gap-1.5">
              <input type="text" ref={productInputRef} value={searchQuery}
                onChange={e => { setSearchQuery(e.target.value); setShowSearchDrop(true); }}
                onFocus={() => setShowSearchDrop(true)}
                onKeyDown={e => {
                  if (!showSearchDrop) return;
                  if (e.key === "ArrowDown") {
                    e.preventDefault();
                    setProductHighlight(h => Math.min(h + 1, searchResults.length - 1));
                  } else if (e.key === "ArrowUp") {
                    e.preventDefault();
                    setProductHighlight(h => Math.max(h - 1, 0));
                  } else if (e.key === "Enter") {
                    if (productHighlight >= 0 && productHighlight < searchResults.length) {
                      e.preventDefault();
                      addVariant(searchResults[productHighlight]);
                    }
                  } else if (e.key === "Escape") {
                    setShowSearchDrop(false);
                  }
                }}
                placeholder="상품명, 색상, 사이즈 검색... (Alt+I)"
                className={`flex-1 min-w-0 ${INPUT_MD}`} />
              <button
                onMouseDown={e => { e.preventDefault(); setShowProductModal(true); }}
                className="px-3 py-1.5 text-xs font-semibold text-primary border border-primary-border rounded hover:bg-primary-soft whitespace-nowrap shrink-0"
              >+ 상품</button>
            </div>
            {showSearchDrop && searchResults.length > 0 && (
              <div className="absolute bottom-full mb-1 bg-white border border-gray-200 rounded-lg shadow-lg z-50 max-h-72 overflow-y-auto"
                style={{ left: "calc(-100% - 0.5rem)", right: 0 }}>
                <table className="w-full text-sm">
                  <thead className="bg-gray-50 border-b border-gray-100 sticky top-0 z-10">
                    <tr>
                      <th className="text-left px-3 py-1.5 text-xs text-gray-500">상품명</th>
                      <th className="text-center px-2 py-1.5 text-xs text-gray-500">색상</th>
                      <th className="text-center px-2 py-1.5 text-xs text-gray-500">사이즈</th>
                      <th className="text-right px-2 py-1.5 text-xs text-gray-500">단가</th>
                      <th className="text-right px-3 py-1.5 text-xs text-gray-500">재고</th>
                      <th className="w-20 px-2 py-1.5"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {searchResults.map((v, idx) => (
                      <tr key={v.variant_id}
                        ref={el => { if (el) productOptionRefs.current.set(v.variant_id, el); else productOptionRefs.current.delete(v.variant_id); }}
                        onMouseEnter={() => setProductHighlight(idx)}
                        onClick={() => addVariant(v)}
                        className={`border-t border-gray-100 cursor-pointer ${idx === productHighlight ? "bg-primary-soft" : "hover:bg-primary-soft"}`}>
                        <td className="px-3 py-1.5 font-medium text-gray-800">
                          <span>{v.product_name}</span>
                          {v.is_sale && <span className="ml-1.5 text-[10px] font-semibold text-rose-600">(세일)</span>}
                        </td>
                        <td className="px-2 py-1.5 text-center text-gray-600">{v.color}</td>
                        <td className="px-2 py-1.5 text-center text-gray-600">{v.size}</td>
                        <td className="px-2 py-1.5 text-right text-gray-600">{getPrice(v.variant_id, v.base_price).toLocaleString()}</td>
                        <td className={`px-3 py-1.5 text-right text-xs font-medium ${v.stock === 0 ? "text-red-400" : "text-gray-500"}`}>{v.stock}개</td>
                        <td className="px-2 py-1.5 text-right">
                          <button
                            onClick={e => { e.stopPropagation(); addVariant(v, true); }}
                            className="px-3 py-1.5 text-xs font-semibold text-white bg-primary rounded hover:bg-primary-hover whitespace-nowrap"
                            title="추가 (드롭다운 유지)"
                          >추가</button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>

        {/* 4버튼 — 맨 아래. savedOrder 시 hide (저장 완료 UI 가 위 합계 영역에 표시됨). */}
        {!savedOrder && (() => {
          const inputsEmpty = saving || items.length === 0 || !selectedCustomer;
          return (
          <div className={`border-t border-gray-200 px-4 py-3 shrink-0 ${compact ? "sticky bottom-0 z-20 bg-white shadow-[0_-2px_6px_rgba(0,0,0,0.04)]" : "bg-gray-50"}`}>
            <div className="grid grid-cols-4 gap-2">
              <Button variant="sample" onClick={() => handleSave("sample")} disabled={inputsEmpty} title="샘플등록 — staging (Alt+E)" className="w-full">
                {saving ? "저장중..." : "샘플등록"} <kbd className="ml-1 text-[10px] font-normal opacity-70">Alt+E</kbd>
              </Button>
              <Button variant="sample" onClick={() => handleSave("sample-immediate")} disabled={inputsEmpty} title="샘플즉시 — 현장 출고 (Alt+R)" className="w-full">
                {saving ? "저장중..." : "샘플즉시"} <kbd className="ml-1 text-[10px] font-normal opacity-70">Alt+R</kbd>
              </Button>
              <Button onClick={() => handleSave("order")} disabled={inputsEmpty} title="주문등록 — staging (Alt+S)" className="w-full">
                {saving ? "저장중..." : "주문등록"} <kbd className="ml-1 text-[10px] font-normal opacity-70">Alt+S</kbd>
              </Button>
              <Button onClick={() => handleSave("order-immediate")} disabled={inputsEmpty} title="주문즉시 — 등록+출고+거래처 기본 결제수단 (Alt+D)" className="w-full">
                {saving ? "저장중..." : "주문즉시"} <kbd className="ml-1 text-[10px] font-normal opacity-70">Alt+D</kbd>
              </Button>
            </div>
          </div>
          );
        })()}
      </div>

      {/* 오른쪽: 상품 그리드 */}
      {!compact && (
      <div className="flex-[4] min-w-0 flex flex-col bg-white overflow-hidden">

        {/* 카테고리 탭 */}
        <div className="border-b border-gray-200 shrink-0">
          <div className="flex flex-wrap px-1 pt-1">
            {categories.map(cat => (
              <button key={cat}
                onClick={() => { setActiveCategory(cat); setActiveProductId(null); }}
                className={`px-3 py-2 mb-1 text-xs font-medium rounded-md transition-colors ${
                  activeCategory === cat ? "bg-primary text-white" : "text-gray-500 hover:bg-gray-100"
                }`}>
                {cat}
              </button>
            ))}
          </div>
        </div>

        {/* 상품 카드 */}
        <div className="flex-1 overflow-y-auto p-2 grid grid-cols-4 gap-2 content-start">
          {gridProducts.map(p => (
            <button key={p.product_id}
              onClick={() => setActiveProductId(activeProductId === p.product_id ? null : p.product_id)}
              className={`flex flex-col items-center justify-center p-2 rounded-lg border-2 transition-colors text-center min-h-[60px] gap-0.5 ${
                activeProductId === p.product_id
                  ? "border-primary-ring bg-primary-soft"
                  : "border-gray-200 hover:border-primary-border hover:bg-primary-soft"
              }`}>
              <span className="text-xs font-semibold text-gray-800 leading-tight line-clamp-2">{p.product_name}</span>
              <span className="text-xs text-primary font-medium">{p.base_price.toLocaleString()}원</span>
            </button>
          ))}
        </div>

        {/* 옵션 패널 */}
        {activeProductId && activeVariants.length > 0 && (
          <div className="border-t-2 border-primary-border bg-primary-soft shrink-0">
            <div className="px-3 py-2 flex items-center justify-between border-b border-primary-soft-hover">
              <p className="text-xs font-semibold text-primary-hover truncate">{activeVariants[0].product_name}</p>
              <button onClick={() => setActiveProductId(null)} className="text-primary-ring hover:text-primary ml-2 text-lg leading-none">×</button>
            </div>
            <div className="max-h-44 overflow-y-auto">
              {activeVariants.map(v => (
                <div key={v.variant_id}
                  className="flex items-center gap-2 px-3 py-2 border-b border-primary-soft-hover hover:bg-primary-soft-hover transition-colors">
                  <span className="text-xs font-medium text-gray-700 w-12 shrink-0 truncate">{v.color}</span>
                  <span className="text-xs text-gray-500 w-8 shrink-0">{v.size}</span>
                  <span className={`text-xs w-8 shrink-0 ${v.stock === 0 ? "text-red-400" : "text-gray-500"}`}>{v.stock}</span>
                  <button onClick={() => addVariant(v)}
                    className="ml-auto text-xs px-2.5 py-1 bg-primary text-white rounded-lg hover:bg-primary-hover shrink-0">추가</button>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
      )}

      {/* 맨 오른쪽: 영수증 미리보기 컬럼 (compact 면 hide) */}
      {!compact && (
      <div className="flex-[2] min-w-0 flex flex-col bg-gray-50 border-l border-gray-200 overflow-hidden">
        <div className="px-4 py-2 border-b border-gray-200 bg-white shrink-0">
          <span className="text-xs font-semibold text-gray-700">영수증 미리보기</span>
        </div>
        <div className="flex-1 overflow-y-auto py-3 flex justify-center">
          <ReceiptPreview doc={previewDoc} />
        </div>
      </div>
      )}

      {/* 영수증 출력 모달 — 저장 후 [영수증 출력] 누를 때만 표시 */}
      {showPrintModal && savedOrder && (
        <ReceiptPrintModal
          orderId={savedOrder.id}
          onClose={() => setShowPrintModal(false)}
        />
      )}

      {/* 거래처 모달 — 신규 등록 (editing=null) 또는 수정 (editing 채워짐). 같은 모듈 재사용. */}
      {showCustomerModal && (
        <CustomerModal
          editing={editingCustomer}
          onClose={() => { setShowCustomerModal(false); setEditingCustomer(null); }}
          onSaved={(saved) => {
            const wasEditing = !!editingCustomer;
            setShowCustomerModal(false);
            setEditingCustomer(null);
            // 거래처 목록 갱신 (신규/수정 둘 다 — 표시 컬럼 변동 가능)
            fetchCustomers();
            // 신규 등록 시 saved row 반환 → 즉시 선택. 수정은 saved undefined 라 그대로.
            if (saved && !wasEditing) {
              selectCustomer({
                id: saved.id,
                company_name: saved.company_name,
                outstanding_balance: saved.outstanding_balance,
                credit_limit: saved.credit_limit,
                include_vat: saved.include_vat,
                default_payment_method: saved.default_payment_method,
                region: saved.region,
                business_form: saved.business_form,
              });
            }
          }}
        />
      )}

      {/* 상품 신규 등록 모달 — 상품 관리 페이지와 동일 모듈 (ProductModal) 사용 */}
      {showProductModal && (
        <ProductModal
          editing={null}
          categories={productCategories}
          onClose={() => setShowProductModal(false)}
          onSaved={() => {
            setShowProductModal(false);
            // 신규 등록 → 옵션 목록 갱신 (검색 드롭다운에 즉시 노출)
            fetchVariantsWithStock();
          }}
          onCategoryAdded={(name) => {
            setProductCategories(prev => prev.includes(name) ? prev : [...prev, name].sort());
          }}
        />
      )}
    </div>
  );
}
