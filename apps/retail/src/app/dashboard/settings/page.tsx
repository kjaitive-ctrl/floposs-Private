"use client";

import { useEffect, useState, Suspense } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { styles } from "@/common/styles";
import { supabase } from "@/lib/supabase";
import { bizNumberDigits, formatBizNumber, type PaymentMethod } from "@/lib/orderPortal";
import ModelsSection from "@/components/ModelsSection";
import type { TenantFull } from "@/lib/types";

// retail-site 메인 settings 페이지 (마이그 189).
// 내정보 (마이그 175 + 189 신규 6필드) + 구독 (Free Beta + 만료 D-day) 표시/편집.
//
// /order/me 와 분리: /order/me 는 외부 주문 흐름 안의 마이페이지 (OrderHeader + browse 링크).
// 본 페이지는 NavBar 의 "내정보" 진입점.

type MeTenant = TenantFull;

// useSearchParams는 Suspense 필수 — 별도 컴포넌트로 분리.
function Cafe24OAuthBanner() {
  const searchParams = useSearchParams();
  const param = searchParams.get("cafe24");
  if (!param) return null;
  return param === "connected"
    ? <div className={`${styles.msgOk} mb-3`}>카페24 연동이 완료되었습니다.</div>
    : <div className={`${styles.msgError} mb-3`}>카페24 연동 중 오류가 발생했습니다. 다시 시도해주세요.</div>;
}

type Cafe24Status = {
  connected: boolean;
  mall_id: string | null;
  expires_at?: string | null;
  updated_at?: string | null;
};

const PAYMENT_LABEL: Record<PaymentMethod, string> = {
  cash: "현금",
  transfer: "계좌이체",
  credit: "외상(청구)",
};

const BILLING_LABEL: Record<string, string> = {
  monthly: "월",
  yearly: "년",
  one_time: "회",
};

type RetailPlan = {
  id: string;
  name: string;
  description: string | null;
  price: number;
  billing_cycle: string;
  features: string[];
  r2_storage_quota_mb: number;  // 마이그 200
};

function formatBytes(b: number): string {
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  if (b < 1024 * 1024 * 1024) return `${(b / 1024 / 1024).toFixed(1)} MB`;
  return `${(b / 1024 / 1024 / 1024).toFixed(2)} GB`;
}
function quotaLabel(mb: number): string {
  if (mb === 0) return "무제한";
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`;
  return `${mb} MB`;
}

function daysUntil(iso: string | null): number | null {
  if (!iso) return null;
  const ms = new Date(iso).getTime() - Date.now();
  return Math.ceil(ms / (1000 * 60 * 60 * 24));
}

export default function SettingsPage() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [tenant, setTenant] = useState<MeTenant | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  // 카페24 연동
  const [cafe24Status, setCafe24Status] = useState<Cafe24Status | null>(null);
  const [cafe24MallId, setCafe24MallId] = useState("");
  const [cafe24Saving, setCafe24Saving] = useState(false);
  const [cafe24Saved, setCafe24Saved] = useState(false);

  // 카페24 카테고리 매핑
  type Cafe24Cat = { category_no: number; parent_category_no: number | null; category_name: string };
  const [cafe24Cats, setCafe24Cats] = useState<Cafe24Cat[] | null>(null);
  const [retailCategories, setRetailCategories] = useState<string[]>([]);
  const [catMapping, setCatMapping] = useState<Record<string, number | "">>({});
  const [globalCatSlots, setGlobalCatSlots] = useState<(number | "")[]>(["", "", ""]);
  const [catSyncing, setCatSyncing] = useState(false);
  const [catSaving, setCatSaving] = useState(false);
  const [catSaved, setCatSaved] = useState(false);

  // 물류회사(삼촌) 배정 — 베타·DEV 전용 [[project_logi_axis]]
  const [logiOptions, setLogiOptions] = useState<{ id: string; company_name: string }[]>([]);
  const [logiId, setLogiId] = useState("");
  const [logiSaving, setLogiSaving] = useState(false);
  const [logiSaved, setLogiSaved] = useState(false);

  // 편집 state
  const [companyName, setCompanyName] = useState("");
  const [ownerName, setOwnerName] = useState("");
  const [businessNumber, setBusinessNumber] = useState("");
  const [address, setAddress] = useState("");
  const [phone, setPhone] = useState("");
  const [taxInvoiceEmail, setTaxInvoiceEmail] = useState("");
  const [contactEmail, setContactEmail] = useState("");
  const [warehouseSame, setWarehouseSame] = useState(true);
  const [warehouseAddress, setWarehouseAddress] = useState("");
  const [warehousePhone, setWarehousePhone] = useState("");
  const [storeName, setStoreName] = useState("");
  const [storeUrl, setStoreUrl] = useState("");

  // 구독 액션
  const [plans, setPlans] = useState<RetailPlan[]>([]);
  const [subscribing, setSubscribing] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);

  // 브라우저 → Supabase Seoul 직접 호출 — Vercel 라우트 경유 X.
  // [[feedback_retail_browser_supabase_direct]] — 한국 사장 → 미국 Vercel → 서울 supabase 대륙간 hop 2번 → 직접 호출로 1번.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data: { user } } = await supabase.auth.getUser();
      if (cancelled) return;
      if (!user) {
        setError("로그인이 필요합니다.");
        setLoading(false);
        return;
      }
      const tenantId = (user.app_metadata as { tenant_id?: string } | undefined)?.tenant_id;
      if (!tenantId) {
        setError("tenant_id 가 설정되지 않았습니다.");
        setLoading(false);
        return;
      }
      const [{ data, error: fetchError }, { data: planRows }, cafe24Res, catMapRes, retailCatRes, cafe24CatsRes] = await Promise.all([
        supabase
          .from("tenants")
          .select(`
            id, company_name, owner_name, phone, address, business_number, default_payment_method,
            tax_invoice_email, contact_email,
            warehouse_address, warehouse_same_as_office, warehouse_phone,
            store_name, store_url, cafe24_mall_id, cafe24_global_category_nos,
            plan_id, subscription_expires_at, cancel_at_period_end,
            default_logi_tenant_id,
            r2_usage_bytes, r2_image_count,
            subscription_plans(id, name, description, price, billing_cycle, features, r2_storage_quota_mb)
          `)
          .eq("id", tenantId)
          .single(),
        supabase
          .from("subscription_plans")
          .select("id, name, description, price, billing_cycle, features, r2_storage_quota_mb")
          .eq("vertical", "retail")
          .eq("is_active", true)
          .order("price", { ascending: true }),
        fetch("/api/cafe24/status").then(r => r.json() as Promise<Cafe24Status>).catch(() => null),
        fetch("/api/cafe24/category-map").then(r => r.ok ? r.json() : null).catch(() => null),
        supabase
          .from("measurement_templates")
          .select("category")
          .or(`tenant_id.is.null,tenant_id.eq.${tenantId}`)
          .eq("is_active", true)
          .order("sort_order", { ascending: true }),
        fetch("/api/cafe24/categories").then(r => r.ok ? r.json() : null).catch(() => null),
      ]);
      if (cancelled) return;
      if (planRows) setPlans(planRows as RetailPlan[]);
      if (cafe24Res) setCafe24Status(cafe24Res);
      // 카테고리 매핑 초기화
      if (catMapRes?.mappings) {
        const map: Record<string, number | ""> = {};
        (catMapRes.mappings as { retail_category: string; cafe24_category_no: number }[])
          .forEach(m => { map[m.retail_category] = m.cafe24_category_no; });
        setCatMapping(map);
      }
      if (retailCatRes.data) {
        const set = new Set<string>();
        (retailCatRes.data as { category: string }[]).forEach(r => set.add(r.category));
        setRetailCategories(Array.from(set));
      }
      // DB 캐시된 카페24 카테고리 자동 로드 (연동 후 한번이라도 동기화한 경우)
      const catsPayload = cafe24CatsRes as { categories?: Cafe24Cat[] } | null;
      if (catsPayload?.categories && catsPayload.categories.length > 0) {
        setCafe24Cats(catsPayload.categories);
      }
      if (fetchError || !data) {
        setError(fetchError?.message ?? "정보를 불러오지 못했습니다.");
      } else {
        const t = data as unknown as MeTenant;
        setTenant(t);
        setCompanyName(t.company_name ?? "");
        setOwnerName(t.owner_name ?? "");
        setBusinessNumber(bizNumberDigits(t.business_number ?? ""));
        setAddress(t.address ?? "");
        setPhone(t.phone ?? "");
        setTaxInvoiceEmail(t.tax_invoice_email ?? "");
        setContactEmail(t.contact_email ?? "");
        setWarehouseSame(t.warehouse_same_as_office ?? true);
        setWarehouseAddress(t.warehouse_address ?? "");
        setWarehousePhone(t.warehouse_phone ?? "");
        setStoreName(t.store_name ?? "");
        setStoreUrl(t.store_url ?? "");
        setCafe24MallId(t.cafe24_mall_id ?? "");
        const savedGlobal = (t.cafe24_global_category_nos ?? []) as number[];
        setGlobalCatSlots([savedGlobal[0] ?? "", savedGlobal[1] ?? "", savedGlobal[2] ?? ""]);
        setLogiId((data as { default_logi_tenant_id?: string | null }).default_logi_tenant_id ?? "");
      }
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, []);

  // 물류회사 옵션 로드 — 베타·DEV 전용 (prod 빌드 시 NODE_ENV='production' 으로 스킵).
  useEffect(() => {
    if (process.env.NODE_ENV === "production") return;
    supabase.from("tenants").select("id, company_name")
      .eq("tenant_type", "logistics").eq("is_active", true)
      .order("company_name")
      .then(({ data }) => setLogiOptions((data as { id: string; company_name: string }[]) ?? []));
  }, []);

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!tenant) return;
    setSaving(true);
    // 브라우저 → Supabase Seoul 직통 (vercel 경유 X).
    // 결제수단 변경은 /order/me 전용 (외상 검증 필요) — 본 페이지는 UI read-only 라 정합 안전.
    const { data, error: updateError } = await supabase
      .from("tenants")
      .update({
        company_name: companyName,
        owner_name: ownerName.trim() || companyName,
        business_number: businessNumber.trim() || null,
        address: address || null,
        phone: phone || null,
        tax_invoice_email: taxInvoiceEmail.trim() || null,
        contact_email: contactEmail.trim() || null,
        warehouse_same_as_office: warehouseSame,
        warehouse_address: warehouseSame ? null : (warehouseAddress.trim() || null),
        warehouse_phone: warehousePhone.trim() || null,
        store_name: storeName.trim() || null,
        store_url: storeUrl.trim() || null,
      })
      .eq("id", tenant.id)
      .select(`
        id, company_name, owner_name, phone, address, business_number, default_payment_method,
        tax_invoice_email, contact_email,
        warehouse_address, warehouse_same_as_office, warehouse_phone,
        store_name, store_url,
        plan_id, subscription_expires_at, cancel_at_period_end,
        subscription_plans(id, name, description, price, billing_cycle, features)
      `)
      .single();
    setSaving(false);
    if (updateError || !data) {
      setError(updateError?.message ?? "저장에 실패했습니다.");
      return;
    }
    const updated = data as unknown as MeTenant;
    setTenant(prev => prev ? { ...prev, ...updated } : updated);
    setSavedAt(Date.now());
  }

  // 카페24 몰 ID 저장 (tenants.cafe24_mall_id). browser-direct.
  async function handleSaveCafe24MallId() {
    if (!tenant) return;
    setCafe24Saving(true);
    const { error: err } = await supabase.from("tenants")
      .update({ cafe24_mall_id: cafe24MallId.trim() || null })
      .eq("id", tenant.id);
    setCafe24Saving(false);
    if (err) { alert(err.message); return; }
    setTenant(prev => prev ? { ...prev, cafe24_mall_id: cafe24MallId.trim() || null } : prev);
    setCafe24Saved(true);
    setTimeout(() => setCafe24Saved(false), 3000);
  }

  // 카페24 카테고리 동기화 — API 호출로 카테고리 fetch + state 저장
  async function syncCafe24Categories() {
    setCatSyncing(true);
    try {
      const res = await fetch("/api/cafe24/categories?sync=1");
      const data = await res.json() as { categories?: { category_no: number; parent_category_no: number | null; category_name: string }[]; error?: string };
      if (!res.ok || data.error) { alert(data.error ?? "카테고리 동기화 실패"); return; }
      setCafe24Cats(data.categories ?? []);
    } catch (e) { alert(String(e)); }
    setCatSyncing(false);
  }

  // 카테고리 매핑 저장 (개별 매핑 + 공통 슬롯 동시 저장)
  async function saveCategoryMapping() {
    if (!tenant) return;
    setCatSaving(true);
    const mappings = retailCategories.map(rc => ({
      retail_category: rc,
      cafe24_category_no: catMapping[rc] ? Number(catMapping[rc]) : null,
    }));
    const globalNos = globalCatSlots.filter(v => !!v).map(v => Number(v));
    try {
      const [mapRes] = await Promise.all([
        fetch("/api/cafe24/category-map", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ mappings }),
        }),
        supabase.from("tenants")
          .update({ cafe24_global_category_nos: globalNos.length > 0 ? globalNos : null })
          .eq("id", tenant.id),
      ]);
      const data = await mapRes.json() as { ok?: boolean; error?: string };
      if (!mapRes.ok || data.error) { alert(data.error ?? "저장 실패"); return; }
      setCatSaved(true);
      setTimeout(() => setCatSaved(false), 3000);
    } catch (e) { alert(String(e)); }
    setCatSaving(false);
  }

  // 물류회사(삼촌) 배정 저장 — 베타·DEV 전용. browser-direct.
  async function handleSaveLogi() {
    if (!tenant) return;
    setLogiSaving(true);
    const { error: err } = await supabase.from("tenants")
      .update({ default_logi_tenant_id: logiId || null })
      .eq("id", tenant.id);
    setLogiSaving(false);
    if (err) { alert(err.message); return; }
    setLogiSaved(true);
    setTimeout(() => setLogiSaved(false), 3000);
  }

  // ── 구독: 플랜 선택/변경 ──
  // wholesale handleSubscribe 와 동일 패턴 — 만료 = now + cycle. cancel_at_period_end 자동 false.
  async function handleSubscribe(p: RetailPlan) {
    if (!tenant) return;
    const msg = tenant.plan_id === p.id
      ? `"${p.name}" 구독을 갱신/재개하시겠습니까?`
      : `"${p.name}" 플랜으로 변경하시겠습니까?`;
    if (!confirm(msg)) return;
    setSubscribing(p.id);
    const now = new Date();
    let expires: string | null = null;
    if (p.billing_cycle === "monthly") {
      expires = new Date(now.getFullYear(), now.getMonth() + 1, now.getDate()).toISOString();
    } else if (p.billing_cycle === "yearly") {
      expires = new Date(now.getFullYear() + 1, now.getMonth(), now.getDate()).toISOString();
    }
    const { error: err } = await supabase.from("tenants")
      .update({ plan_id: p.id, subscription_expires_at: expires, cancel_at_period_end: false })
      .eq("id", tenant.id);
    setSubscribing(null);
    if (err) { alert(err.message); return; }
    setTenant({
      ...tenant,
      plan_id: p.id,
      subscription_expires_at: expires,
      cancel_at_period_end: false,
      subscription_plans: {
        id: p.id, name: p.name, description: p.description,
        price: p.price, billing_cycle: p.billing_cycle, features: p.features,
        r2_storage_quota_mb: p.r2_storage_quota_mb,
      },
    });
  }

  // ── 구독: 취소 예약 / 철회 ──
  // 만료일까지 사용 가능 + 만료 시 자동 해지. 다시 토글하면 철회.
  async function handleCancelToggle() {
    if (!tenant) return;
    const willCancel = !tenant.cancel_at_period_end;
    const expIso = tenant.subscription_expires_at;
    const expLabel = expIso ? new Date(expIso).toLocaleDateString("ko-KR") : "(만료일 미정)";
    const msg = willCancel
      ? `구독을 취소하시겠습니까?\n만료일(${expLabel})까지 사용 가능하고, 만료 시 자동 해지됩니다.`
      : "구독 취소 예약을 철회하시겠습니까?";
    if (!confirm(msg)) return;
    setCancelling(true);
    const { error: err } = await supabase.from("tenants")
      .update({ cancel_at_period_end: willCancel })
      .eq("id", tenant.id);
    setCancelling(false);
    if (err) { alert(err.message); return; }
    setTenant({ ...tenant, cancel_at_period_end: willCancel });
  }

  const daysLeft = daysUntil(tenant?.subscription_expires_at ?? null);
  const plan = tenant?.subscription_plans;
  const isExpired = daysLeft !== null && daysLeft <= 0;

  return (
    <main className={styles.main}>
      <div className="max-w-5xl mx-auto">
        <h1 className="text-xl font-bold text-black mb-1">내정보 · 설정</h1>
        <p className="text-xs text-gray-500 mb-6">
          업체 정보 + 결제수단 + 구독 관리. 휴대폰(아이디) · 결제수단은 별 처리 ({" "}
          <Link href="/order/me" className="underline">/order/me</Link> 참고).
        </p>

        {loading ? (
          <div className="text-xs text-gray-400">불러오는 중…</div>
        ) : !tenant ? (
          <div className="text-xs text-red-600">{error ?? "정보 없음"}</div>
        ) : (
          <>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 items-start">
            {/* ── 왼쪽: 내정보 폼 (긴 컬럼) ── */}
            <form onSubmit={handleSave} className={`${styles.card} space-y-4`}>
              <h2 className="text-sm font-bold text-black mb-1">내정보</h2>

              {/* 업체 */}
              <div className={styles.modalSection}>업체</div>
              <div>
                <label className={styles.modalLabel}>업체명 (사업자등록증 상호)</label>
                <input className={styles.modalInput} required
                  value={companyName} onChange={e => setCompanyName(e.target.value)} />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className={styles.modalLabel}>대표자명</label>
                  <input className={styles.modalInput} placeholder="(선택)"
                    value={ownerName} onChange={e => setOwnerName(e.target.value)} />
                </div>
                <div>
                  <label className={styles.modalLabel}>사업자등록번호</label>
                  <input className={styles.modalInput} inputMode="numeric" placeholder="000-00-00000"
                    value={formatBizNumber(businessNumber)}
                    onChange={e => setBusinessNumber(bizNumberDigits(e.target.value))} />
                </div>
              </div>
              <div>
                <label className={styles.modalLabel}>사무실주소</label>
                <input className={styles.modalInput} placeholder="(선택)"
                  value={address} onChange={e => setAddress(e.target.value)} />
              </div>
              <div>
                <label className={styles.modalLabel}>사장님 연락처</label>
                <input className={styles.modalInput} placeholder="(선택) 사장님 휴대폰"
                  value={phone} onChange={e => setPhone(e.target.value)} />
              </div>

              {/* 이메일 */}
              <div className={styles.modalSection}>이메일</div>
              <div>
                <label className={styles.modalLabel}>세금계산서 발행용</label>
                <input type="email" className={styles.modalInput} placeholder="tax@example.com"
                  value={taxInvoiceEmail} onChange={e => setTaxInvoiceEmail(e.target.value)} />
              </div>
              <div>
                <label className={styles.modalLabel}>담당자용</label>
                <input type="email" className={styles.modalInput} placeholder="manager@example.com"
                  value={contactEmail} onChange={e => setContactEmail(e.target.value)} />
              </div>

              {/* 물류 / 매장 */}
              <div className={styles.modalSection}>물류 / 매장</div>
              <div>
                <label className="flex items-center gap-2 text-xs text-black mb-2">
                  <input type="checkbox" checked={warehouseSame}
                    onChange={e => setWarehouseSame(e.target.checked)}
                    className="rounded" />
                  사무실 주소와 동일
                </label>
                {!warehouseSame && (
                  <input className={styles.modalInput} placeholder="물류/매장 주소"
                    value={warehouseAddress} onChange={e => setWarehouseAddress(e.target.value)} />
                )}
              </div>
              <div>
                <label className={styles.modalLabel}>물류/매장 연락처</label>
                <input className={styles.modalInput} placeholder="(선택) 현장 연락처"
                  value={warehousePhone} onChange={e => setWarehousePhone(e.target.value)} />
              </div>

              {/* 쇼핑몰 */}
              <div className={styles.modalSection}>쇼핑몰 / 매장</div>
              <div>
                <label className={styles.modalLabel}>쇼핑몰/매장명</label>
                <input className={styles.modalInput} placeholder="고객에게 보이는 이름 (브랜드명)"
                  value={storeName} onChange={e => setStoreName(e.target.value)} />
              </div>
              <div>
                <label className={styles.modalLabel}>쇼핑몰 주소 (URL)</label>
                <input type="url" className={styles.modalInput} placeholder="https://..."
                  value={storeUrl} onChange={e => setStoreUrl(e.target.value)} />
              </div>

              {/* 읽기 전용 (정책상 변경 X) */}
              <div className={styles.modalSection}>고정 (변경 불가)</div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className={styles.modalLabel}>휴대폰 (아이디)</label>
                  <input className={`${styles.modalInput} ${styles.inputDisabled}`} value={tenant.phone ?? ""} readOnly disabled />
                </div>
                <div>
                  <label className={styles.modalLabel}>기본 결제수단</label>
                  <input className={`${styles.modalInput} ${styles.inputDisabled}`}
                    value={tenant.default_payment_method ? PAYMENT_LABEL[tenant.default_payment_method] : "-"}
                    readOnly disabled />
                </div>
              </div>

              {error && (
                <div className={styles.msgError}>{error}</div>
              )}
              {savedAt && !error && (
                <div className={styles.msgOk}>저장되었습니다.</div>
              )}

              <button type="submit" disabled={saving}
                className={`${styles.btnPrimary} w-full disabled:opacity-50 mt-2`}>
                {saving ? "저장 중…" : "저장"}
              </button>
            </form>

            {/* ── 오른쪽: 구독(위) + 모델 관리(아래) ── */}
            <div className="space-y-4">
              {/* 구독 카드 — 중요도 높아 상단 */}
              <div className={styles.card}>
                <h2 className="text-sm font-bold text-black mb-3">구독</h2>
                {plan ? (
                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <span className="text-base font-semibold text-black">{plan.name}</span>
                      <span className="text-sm text-gray-600">
                        {plan.price === 0 ? "무료" : `${plan.price.toLocaleString()}원 / ${plan.billing_cycle === "monthly" ? "월" : plan.billing_cycle === "yearly" ? "년" : "회"}`}
                      </span>
                    </div>
                    {plan.description && (
                      <p className="text-xs text-gray-500">{plan.description}</p>
                    )}
                    {tenant.subscription_expires_at && (
                      <div className="flex items-center gap-2 text-xs mt-2 pt-2 border-t border-gray-100">
                        <span className="text-gray-500">만료일</span>
                        <span className="text-black font-medium">
                          {new Date(tenant.subscription_expires_at).toLocaleDateString("ko-KR")}
                        </span>
                        {daysLeft !== null && (
                          <span className={`ml-auto px-2 py-0.5 rounded text-[11px] font-semibold ${
                            daysLeft <= 7 ? "bg-red-50 text-red-700 border border-red-200"
                            : daysLeft <= 30 ? "bg-amber-50 text-amber-700 border border-amber-200"
                            : "bg-gray-50 text-gray-700 border border-gray-200"
                          }`}>
                            D-{Math.max(0, daysLeft)}
                          </span>
                        )}
                      </div>
                    )}

                    {/* 이미지 데이터 사용량 — 마이그 200 캐시 기반 */}
                    {(() => {
                      const usage = tenant.r2_usage_bytes ?? 0;
                      const quotaMb = plan.r2_storage_quota_mb ?? 0;
                      const quotaBytes = quotaMb * 1024 * 1024;
                      const unlimited = quotaMb === 0;
                      const pct = unlimited ? 0 : Math.min(100, (usage / quotaBytes) * 100);
                      const overWarn = !unlimited && pct >= 90;
                      const overFull = !unlimited && pct >= 100;
                      return (
                        <div className="mt-3 pt-3 border-t border-gray-100">
                          <div className="flex items-center justify-between text-xs mb-1.5">
                            <span className="text-gray-500">이미지 사용량</span>
                            <span className={`font-medium ${overFull ? "text-red-600" : overWarn ? "text-orange-600" : "text-black"}`}>
                              {formatBytes(usage)}
                              {!unlimited && <span className="text-gray-400"> / {quotaLabel(quotaMb)}</span>}
                              {unlimited && <span className="text-gray-400"> · 무제한</span>}
                            </span>
                          </div>
                          {!unlimited && (
                            <div className="h-1.5 bg-gray-200 rounded overflow-hidden">
                              <div className={`h-full transition-all ${overFull ? "bg-red-500" : overWarn ? "bg-orange-500" : "bg-blue-500"}`}
                                style={{ width: `${pct}%` }} />
                            </div>
                          )}
                          {!unlimited && overWarn && (
                            <p className={`text-[11px] mt-1 ${overFull ? "text-red-600" : "text-orange-600"}`}>
                              {overFull ? "한도 초과 — 새 이미지 업로드 불가" : `한도 ${Math.round(100 - pct)}% 남음 — 곧 초과 예정`}
                            </p>
                          )}
                          <p className="text-[11px] text-gray-400 mt-1">
                            상품 이미지 총 {tenant.r2_image_count ?? 0}장
                          </p>
                        </div>
                      );
                    })()}

                    {plan.features && plan.features.length > 0 && (
                      <ul className="text-[11px] text-gray-600 mt-2 space-y-0.5">
                        {plan.features.map((f, i) => (
                          <li key={i}>· {f}</li>
                        ))}
                      </ul>
                    )}

                    {/* 취소 예약 안내 */}
                    {tenant.cancel_at_period_end && !isExpired && (
                      <div className="text-[11px] text-amber-700 bg-amber-50 border border-amber-200 rounded px-2 py-1.5 mt-2">
                        ⚠ 만료일에 자동 해지 예약됨. 아래 &quot;취소 철회&quot;로 되돌릴 수 있습니다.
                      </div>
                    )}

                    {/* 구독 취소 / 철회 버튼 */}
                    {!isExpired && (
                      <button onClick={handleCancelToggle} disabled={cancelling}
                        className={`text-xs px-3 py-1.5 rounded border transition-colors disabled:opacity-50 mt-2 ${
                          tenant.cancel_at_period_end
                            ? "border-green-300 text-green-700 hover:bg-green-50"
                            : "border-red-200 text-red-500 hover:bg-red-50"
                        }`}>
                        {cancelling ? "처리 중..." : tenant.cancel_at_period_end ? "구독 취소 철회" : "구독 취소"}
                      </button>
                    )}
                  </div>
                ) : (
                  <div className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded px-3 py-2">
                    구독 중인 플랜이 없습니다. 아래에서 플랜을 선택해주세요.
                  </div>
                )}

                {/* 플랜 선택 / 변경 */}
                {plans.length > 0 && (
                  <div className="pt-3 mt-3 border-t border-gray-100">
                    <p className="text-xs text-gray-500 mb-2">
                      {plan ? "플랜 변경" : "플랜 선택"}
                    </p>
                    <div className="space-y-1.5">
                      {plans.map(p => {
                        const isCurrent = p.id === tenant.plan_id;
                        return (
                          <div key={p.id}
                            className={`flex items-center gap-2 px-2 py-1.5 rounded border ${
                              isCurrent ? "border-black bg-gray-50" : "border-gray-200"
                            }`}>
                            <div className="flex-1 min-w-0">
                              <div className="text-xs font-medium text-black truncate">{p.name}</div>
                              <div className="text-[11px] text-gray-500">
                                {p.price === 0
                                  ? "무료"
                                  : `${p.price.toLocaleString()}원 / ${BILLING_LABEL[p.billing_cycle] ?? p.billing_cycle}`}
                                <span className="ml-2 text-gray-400">· 이미지 {quotaLabel(p.r2_storage_quota_mb ?? 0)}</span>
                              </div>
                            </div>
                            {isCurrent ? (
                              <span className="text-[11px] text-gray-500 whitespace-nowrap">현재</span>
                            ) : (
                              <button onClick={() => handleSubscribe(p)} disabled={subscribing === p.id}
                                className={styles.btnSmall + " whitespace-nowrap"}>
                                {subscribing === p.id ? "처리 중..." : "선택"}
                              </button>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}
              </div>

              {/* 모델 관리 — 구독 아래 */}
              <ModelsSection tenantId={tenant.id} />
            </div>
          </div>

          {/* 카페24 연동 */}
          <div className={`${styles.card} mt-4`}>
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-sm font-bold text-black">카페24 연동</h2>
              {cafe24Status?.connected ? (
                <span className="text-[11px] px-2 py-0.5 bg-green-50 text-green-700 border border-green-200 rounded-full font-medium">
                  연동됨
                </span>
              ) : (
                <span className="text-[11px] px-2 py-0.5 bg-gray-100 text-gray-500 border border-gray-200 rounded-full">
                  미연동
                </span>
              )}
            </div>

            {/* OAuth 콜백 결과 */}
            <Suspense>
              <Cafe24OAuthBanner />
            </Suspense>

            {cafe24Status?.connected && (
              <div className="text-xs text-gray-500 bg-gray-50 rounded px-3 py-2 mb-3">
                <span className="font-medium text-black">{cafe24Status.mall_id}.cafe24.com</span>
                {cafe24Status.updated_at && (
                  <span className="ml-2 text-gray-400">
                    · 마지막 연동 {new Date(cafe24Status.updated_at).toLocaleDateString("ko-KR")}
                  </span>
                )}
              </div>
            )}

            <div className="space-y-3">
              <div>
                <label className={styles.modalLabel}>카페24 몰 ID</label>
                <p className="text-[11px] text-gray-400 mb-1">
                  쇼핑몰 주소 <span className="font-mono">몰ID.cafe24.com</span> 에서 앞부분
                </p>
                <div className="flex gap-2">
                  <input
                    className={`${styles.modalInput} flex-1 font-mono`}
                    placeholder="예: ggommie"
                    value={cafe24MallId}
                    onChange={e => { setCafe24MallId(e.target.value.trim()); setCafe24Saved(false); }}
                  />
                  <button
                    type="button"
                    onClick={handleSaveCafe24MallId}
                    disabled={cafe24Saving}
                    className={`${styles.btnSecondary} whitespace-nowrap disabled:opacity-50`}
                  >
                    {cafe24Saving ? "저장 중…" : "저장"}
                  </button>
                </div>
                {cafe24Saved && (
                  <div className={`${styles.msgOk} mt-1.5`}>저장되었습니다.</div>
                )}
              </div>

              <div className="pt-2 border-t border-gray-100">
                {tenant?.cafe24_mall_id ? (
                  <a
                    href={`/api/cafe24/authorize?mall_id=${encodeURIComponent(tenant.cafe24_mall_id)}`}
                    className={`${styles.btnPrimary} inline-block text-center w-full`}
                  >
                    {cafe24Status?.connected ? "카페24 재연동" : "카페24 연동 시작"}
                  </a>
                ) : (
                  <button
                    type="button"
                    disabled
                    className={`${styles.btnPrimary} w-full opacity-40 cursor-not-allowed`}
                  >
                    몰 ID를 먼저 저장하세요
                  </button>
                )}
                <p className="text-[11px] text-gray-400 mt-1.5">
                  카페24 판매자 계정으로 로그인 후 권한을 허용하면 자동으로 연동됩니다.
                </p>
              </div>

              {/* 카테고리 매핑 — 연동된 경우만 노출 */}
              {cafe24Status?.connected && retailCategories.length > 0 && (
                <div className="pt-3 mt-3 border-t border-gray-100">
                  <div className="flex items-center justify-between mb-2">
                    <p className="text-xs font-semibold text-black">카테고리 매핑</p>
                    <button
                      type="button"
                      onClick={syncCafe24Categories}
                      disabled={catSyncing}
                      className={`${styles.btnSmallGhost} text-[11px] disabled:opacity-50`}
                    >
                      {catSyncing ? "동기화 중…" : (cafe24Cats ? "재동기화" : "카테고리 불러오기")}
                    </button>
                  </div>
                  <p className="text-[11px] text-gray-400 mb-3">
                    플로포스 카테고리 → 카페24 카테고리 매핑 (전송 시 자동 적용)
                  </p>
                  {cafe24Cats === null ? (
                    <p className="text-[11px] text-gray-400">위 버튼으로 카페24 카테고리를 먼저 불러오세요.</p>
                  ) : (
                    <div className="space-y-2">
                      {(() => {
                        // 카페24 카테고리 트리 구성 (parent_no 기준)
                        const roots = cafe24Cats.filter(c => c.parent_category_no === 1 || c.parent_category_no === null);
                        type CatOption = { value: number; label: string };
                        const buildOptions = (): CatOption[] => {
                          const opts: CatOption[] = [];
                          const addWithChildren = (parent: typeof cafe24Cats[0], prefix: string) => {
                            opts.push({ value: parent.category_no, label: prefix + parent.category_name });
                            cafe24Cats
                              .filter(c => c.parent_category_no === parent.category_no)
                              .forEach(child => addWithChildren(child, prefix + parent.category_name + " > "));
                          };
                          roots.forEach(r => addWithChildren(r, ""));
                          return opts;
                        };
                        const catOptions = buildOptions();
                        return (
                          <>
                            {/* 카테고리별 매핑 */}
                            {retailCategories.map(rc => (
                              <div key={rc} className="flex items-center gap-2">
                                <span className="text-xs text-black w-28 shrink-0">{rc}</span>
                                <select
                                  value={catMapping[rc] ?? ""}
                                  onChange={e => setCatMapping(prev => ({ ...prev, [rc]: e.target.value ? Number(e.target.value) : "" }))}
                                  className={`${styles.modalInput} flex-1 text-xs`}
                                >
                                  <option value="">(매핑 없음)</option>
                                  {catOptions.map(o => (
                                    <option key={o.value} value={o.value}>{o.label}</option>
                                  ))}
                                </select>
                              </div>
                            ))}

                            {/* 공통 카테고리 슬롯 — 모든 전송 상품에 항상 포함 */}
                            <div className="pt-2 mt-1 border-t border-gray-100">
                              <p className="text-[11px] text-gray-500 mb-1.5">
                                공통 카테고리 <span className="text-gray-400">(모든 상품 전송 시 자동 포함)</span>
                              </p>
                              {[0, 1, 2].map(i => (
                                <div key={i} className="flex items-center gap-2 mb-1.5">
                                  <span className="text-[11px] text-gray-400 w-28 shrink-0">공통 {i + 1}</span>
                                  <select
                                    value={globalCatSlots[i] ?? ""}
                                    onChange={e => setGlobalCatSlots(prev => {
                                      const next = [...prev] as (number | "")[];
                                      next[i] = e.target.value ? Number(e.target.value) : "";
                                      return next;
                                    })}
                                    className={`${styles.modalInput} flex-1 text-xs`}
                                  >
                                    <option value="">(없음)</option>
                                    {catOptions.map(o => (
                                      <option key={o.value} value={o.value}>{o.label}</option>
                                    ))}
                                  </select>
                                </div>
                              ))}
                            </div>
                          </>
                        );
                      })()}
                      <div className="flex items-center gap-2 pt-1">
                        <button
                          type="button"
                          onClick={saveCategoryMapping}
                          disabled={catSaving}
                          className={`${styles.btnPrimary} disabled:opacity-50`}
                        >
                          {catSaving ? "저장 중…" : "매핑 저장"}
                        </button>
                        {catSaved && <span className="text-[11px] text-green-700">저장되었습니다.</span>}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>

          {/* 물류 / 배송 (베타·DEV 전용) — prod 빌드 시 자동 숨김. [[project_logi_axis]] */}
          {process.env.NODE_ENV !== "production" && (
            <div className={`${styles.card} mt-4`}>
              <div className="flex items-center gap-2 mb-1">
                <h2 className="text-sm font-bold text-black">물류 / 배송</h2>
                <span className="text-[10px] px-1.5 py-0.5 bg-yellow-100 text-yellow-700 rounded">베타 · DEV 전용</span>
              </div>
              <p className="text-xs text-gray-500 mb-3">
                발주 시 픽업을 맡길 기본 물류회사(사입삼촌). 베타 기능이라 dev 에서만 노출됩니다.
              </p>
              <div className="flex items-end gap-2 max-w-md">
                <div className="flex-1">
                  <label className={styles.modalLabel}>기본 물류회사</label>
                  <select className={styles.modalInput} value={logiId}
                    onChange={e => { setLogiId(e.target.value); setLogiSaved(false); }}>
                    <option value="">(지정 안 함)</option>
                    {logiOptions.map(o => <option key={o.id} value={o.id}>{o.company_name}</option>)}
                  </select>
                </div>
                <button type="button" onClick={handleSaveLogi} disabled={logiSaving}
                  className={`${styles.btnPrimary} disabled:opacity-50`}>
                  {logiSaving ? "저장 중…" : "저장"}
                </button>
              </div>
              {logiSaved && <div className={`${styles.msgOk} mt-2`}>물류회사가 저장되었습니다.</div>}
            </div>
          )}
          </>
        )}
      </div>
    </main>
  );
}
