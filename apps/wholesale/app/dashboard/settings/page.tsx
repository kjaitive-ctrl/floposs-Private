"use client";

import { useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { supabase } from "@/lib/supabase";
import { getOrCreateTenantId } from "@/lib/tenant";
import { krw, formatDate } from "@/lib/format";
import { useAccount } from "@/lib/useAccount";
import StaffAccountsSection from "./_components/StaffAccountsSection";
import ReceiptTemplateSection from "./_components/ReceiptTemplateSection";
import Button from "../_components/Button";
import { PageHeader, PageActionBar, PAGE_ACTION_BAR_SPACER } from "../_components/DataTable";

type Tab = "info" | "receipt" | "subscription" | "staff";

// ── 타입 ──────────────────────────────────────────────

type TenantSettings = {
  company_name: string;
  address: string;
  business_number: string;
  owner_name: string;
  phone: string;
  biz_address: string;
  business_type: string;
  business_category: string;
  sample_period_days: number;
  store_building: string;
  store_floor_unit: string;
  store_name: string;
  main_bank_name: string;
  main_bank_account: string;
  main_bank_holder: string;
  sub_bank_name: string;
  sub_bank_account: string;
  sub_bank_holder: string;
  vat_rate: number;  // 159: 부가세율 (default 0.10 = 10%)
};

type TenantSub = {
  plan_id: string | null;
  subscription_expires_at: string | null;
  cancel_at_period_end: boolean;
};

type Plan = {
  id: string;
  name: string;
  description: string | null;
  price: number;
  billing_cycle: string;
  features: string[];
  is_active: boolean;
};

const BILLING_LABEL: Record<string, string> = {
  monthly: "월",
  yearly: "년",
  one_time: "일회성",
};

const EMPTY_SETTINGS: TenantSettings = {
  company_name: "",
  address: "",
  business_number: "",
  owner_name: "",
  phone: "",
  biz_address: "",
  business_type: "",
  business_category: "",
  sample_period_days: 7,
  store_building: "",
  store_floor_unit: "",
  store_name: "",
  main_bank_name: "",
  main_bank_account: "",
  main_bank_holder: "",
  sub_bank_name: "",
  sub_bank_account: "",
  sub_bank_holder: "",
  vat_rate: 0.10,
};

// ── 컴포넌트 ──────────────────────────────────────────

export default function SettingsPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { isAdmin } = useAccount();
  const initialTab = (searchParams.get("tab") as Tab) ?? "info";
  const [tab, setTab] = useState<Tab>(initialTab);

  // 사장 전용 탭 (subscription/staff) 인데 일반 직원이 URL 직진입 시 info 로 폴백
  useEffect(() => {
    if (!isAdmin && (tab === "subscription" || tab === "staff")) {
      setTab("info");
      router.replace("/dashboard/settings?tab=info");
    }
  }, [isAdmin, tab, router]);
  const [tenantId, setTenantId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  // 내 정보
  const [form, setForm] = useState<TenantSettings>(EMPTY_SETTINGS);
  const [bizSameAsStore, setBizSameAsStore] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  // 구독
  const [tenantSub, setTenantSub] = useState<TenantSub>({ plan_id: null, subscription_expires_at: null, cancel_at_period_end: false });
  const [plans, setPlans] = useState<Plan[]>([]);
  const [subscribing, setSubscribing] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);

  const init = async () => {
    const id = await getOrCreateTenantId();
    setTenantId(id);
    if (!id) { setLoading(false); return; }

    const [{ data: tenant }, { data: planData }] = await Promise.all([
      supabase.from("tenants")
        .select("company_name, address, business_number, owner_name, phone, biz_address, business_type, business_category, sample_period_days, store_building, store_floor_unit, store_name, main_bank_name, main_bank_account, main_bank_holder, sub_bank_name, sub_bank_account, sub_bank_holder, vat_rate, plan_id, subscription_expires_at, cancel_at_period_end")
        .eq("id", id).single(),
      supabase.from("subscription_plans")
        .select("id, name, description, price, billing_cycle, features, is_active")
        .eq("is_active", true).order("sort_order").order("created_at"),
    ]);

    if (tenant) {
      const s: TenantSettings = {
        company_name: tenant.company_name ?? "",
        address: tenant.address ?? "",
        business_number: tenant.business_number ?? "",
        owner_name: tenant.owner_name ?? "",
        phone: tenant.phone ?? "",
        biz_address: tenant.biz_address ?? "",
        business_type: tenant.business_type ?? "",
        business_category: tenant.business_category ?? "",
        sample_period_days: tenant.sample_period_days ?? 7,
        store_building: tenant.store_building ?? "",
        store_floor_unit: tenant.store_floor_unit ?? "",
        store_name: tenant.store_name ?? "",
        main_bank_name: tenant.main_bank_name ?? "",
        main_bank_account: tenant.main_bank_account ?? "",
        main_bank_holder: tenant.main_bank_holder ?? "",
        sub_bank_name: tenant.sub_bank_name ?? "",
        sub_bank_account: tenant.sub_bank_account ?? "",
        sub_bank_holder: tenant.sub_bank_holder ?? "",
        vat_rate: Number(tenant.vat_rate ?? 0.10),
      };
      setForm(s);
      setTenantSub({ plan_id: tenant.plan_id, subscription_expires_at: tenant.subscription_expires_at, cancel_at_period_end: tenant.cancel_at_period_end ?? false });
      if (s.biz_address && s.biz_address === s.address) setBizSameAsStore(true);
    }
    if (planData) setPlans(planData as Plan[]);
    setLoading(false);
  };

  useEffect(() => {
    init();
  }, []);

  function set(key: keyof TenantSettings, value: string | number) {
    setForm(prev => ({ ...prev, [key]: value }));
  }

  function handleSameAsStore(checked: boolean) {
    setBizSameAsStore(checked);
    if (checked) set("biz_address", form.address);
  }

  function handleAddressChange(value: string) {
    set("address", value);
    if (bizSameAsStore) set("biz_address", value);
  }

  async function handleSaveInfo() {
    if (!tenantId) return;
    setSaving(true);
    setSaved(false);
    const { error } = await supabase.from("tenants").update({
      company_name: form.company_name,
      address: form.address,
      business_number: form.business_number,
      owner_name: form.owner_name,
      phone: form.phone,
      biz_address: bizSameAsStore ? form.address : form.biz_address,
      business_type: form.business_type,
      business_category: form.business_category,
      sample_period_days: form.sample_period_days,
      store_building: form.store_building,
      store_floor_unit: form.store_floor_unit,
      store_name: form.store_name,
      main_bank_name: form.main_bank_name,
      main_bank_account: form.main_bank_account,
      main_bank_holder: form.main_bank_holder,
      sub_bank_name: form.sub_bank_name,
      sub_bank_account: form.sub_bank_account,
      sub_bank_holder: form.sub_bank_holder,
      vat_rate: form.vat_rate,
    }).eq("id", tenantId);
    setSaving(false);
    if (!error) { setSaved(true); setTimeout(() => setSaved(false), 3000); }
    else alert(error.message);
  }

  async function handleSubscribe(plan: Plan) {
    if (!tenantId) return;
    if (!confirm(`"${plan.name}" 플랜으로 구독 신청하시겠습니까?`)) return;
    setSubscribing(plan.id);

    const now = new Date();
    let expires: string | null = null;
    if (plan.billing_cycle === "monthly") {
      expires = new Date(now.getFullYear(), now.getMonth() + 1, now.getDate()).toISOString();
    } else if (plan.billing_cycle === "yearly") {
      expires = new Date(now.getFullYear() + 1, now.getMonth(), now.getDate()).toISOString();
    }

    const { error } = await supabase.from("tenants").update({
      plan_id: plan.id,
      subscription_expires_at: expires,
      cancel_at_period_end: false,
    }).eq("id", tenantId);

    if (!error) {
      setTenantSub({ plan_id: plan.id, subscription_expires_at: expires, cancel_at_period_end: false });
    } else {
      alert(error.message);
    }
    setSubscribing(null);
  }

  async function handleCancelToggle() {
    if (!tenantId) return;
    const willCancel = !tenantSub.cancel_at_period_end;
    const msg = willCancel
      ? `구독을 취소하시겠습니까?\n다음 갱신일(${formatDate(tenantSub.subscription_expires_at ?? "")})에 자동으로 해지됩니다.`
      : "구독 취소를 철회하시겠습니까? 예정된 해지가 취소됩니다.";
    if (!confirm(msg)) return;
    setCancelling(true);
    const { error } = await supabase.from("tenants")
      .update({ cancel_at_period_end: willCancel })
      .eq("id", tenantId);
    if (!error) {
      setTenantSub(prev => ({ ...prev, cancel_at_period_end: willCancel }));
    } else {
      alert(error.message);
    }
    setCancelling(false);
  }

  if (loading) return <div className="text-gray-400 text-sm pt-4">불러오는 중...</div>;

  const currentPlan = plans.find(p => p.id === tenantSub.plan_id) ?? null;
  const isExpired = tenantSub.subscription_expires_at
    ? new Date(tenantSub.subscription_expires_at) < new Date()
    : false;
  const isCancelScheduled = tenantSub.cancel_at_period_end && !isExpired;

  return (
    <div className={`${tab === "receipt" ? "max-w-6xl" : "max-w-2xl"} ${PAGE_ACTION_BAR_SPACER}`}>
      <PageHeader title="구독 및 설정" />

      {/* 탭 */}
      <div className="flex border-b border-gray-200 mb-6">
        {(
          [
            ["info", "내 정보"],
            ["receipt", "영수증 양식관리"],
            ...(isAdmin ? [
              ["subscription", "구독 관리"] as [Tab, string],
              ["staff", "매장 계정"] as [Tab, string],
            ] : []),
          ] as [Tab, string][]
        ).map(([key, label]) => (
          <button key={key} onClick={() => { setTab(key); router.replace(`/dashboard/settings?tab=${key}`); }}
            className={`px-5 py-2.5 text-sm font-medium border-b-2 transition-colors -mb-px ${
              tab === key
                ? "border-primary text-primary"
                : "border-transparent text-gray-500 hover:text-gray-700"
            }`}>
            {label}
          </button>
        ))}
      </div>

      {/* ── 영수증 양식관리 탭 ── */}
      {tab === "receipt" && <ReceiptTemplateSection />}

      {/* ── 매장 계정 탭 ── */}
      {tab === "staff" && isAdmin && (
        <div className="space-y-3">
          <p className="text-xs text-gray-600 font-medium">이 탭은 사장님만 볼 수 있습니다.</p>
          <StaffAccountsSection />
        </div>
      )}

      {/* ── 내 정보 탭 ── */}
      {tab === "info" && (
        <div className="space-y-6">

          <section className="bg-white rounded-xl border border-gray-200 p-6">
            <h2 className="text-sm font-semibold text-gray-700 mb-4">매장 정보</h2>
            <div className="space-y-4">
              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1">업체명</label>
                <input type="text" value={form.company_name}
                  onChange={e => set("company_name", e.target.value)}
                  className="w-full input-md"
                  placeholder="예) 홍길동패션" />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1">매장 위치</label>
                <div className="grid grid-cols-3 gap-2">
                  <input type="text" value={form.store_building}
                    onChange={e => set("store_building", e.target.value)}
                    className="input-md"
                    placeholder="건물 (예: 디오트)" />
                  <input type="text" value={form.store_floor_unit}
                    onChange={e => set("store_floor_unit", e.target.value)}
                    className="input-md"
                    placeholder="층호수 (예: 3층 E열 37호)" />
                  <input type="text" value={form.store_name}
                    onChange={e => set("store_name", e.target.value)}
                    className="input-md"
                    placeholder="매장명 (예: 디홀릭)" />
                </div>
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1">매장 주소</label>
                <input type="text" value={form.address}
                  onChange={e => handleAddressChange(e.target.value)}
                  className="w-full input-md"
                  placeholder="예) 서울시 동대문구 장한로 123" />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-medium text-gray-500 mb-1">대표자명</label>
                  <input type="text" value={form.owner_name}
                    onChange={e => set("owner_name", e.target.value)}
                    className="w-full input-md"
                    placeholder="예) 홍길동" />
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-500 mb-1">연락처</label>
                  <input type="text" value={form.phone}
                    onChange={e => set("phone", e.target.value)}
                    className="w-full input-md"
                    placeholder="예) 02-1234-5678" />
                </div>
              </div>
            </div>
          </section>

          <section className="bg-white rounded-xl border border-gray-200 p-6">
            <h2 className="text-sm font-semibold text-gray-700 mb-4">사업자 정보 (세무)</h2>
            <div className="space-y-4">
              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1">사업자등록번호</label>
                <input type="text" value={form.business_number}
                  onChange={e => set("business_number", e.target.value)}
                  className="w-full input-md"
                  placeholder="예) 123-45-67890" />
              </div>
              <div>
                <div className="flex items-center justify-between mb-1">
                  <label className="block text-xs font-medium text-gray-500">사업장 주소</label>
                  <label className="flex items-center gap-1.5 cursor-pointer">
                    <input type="checkbox" checked={bizSameAsStore}
                      onChange={e => handleSameAsStore(e.target.checked)}
                      className="w-3.5 h-3.5 accent-primary" />
                    <span className="text-xs text-gray-500">매장 주소와 동일</span>
                  </label>
                </div>
                <input type="text"
                  value={bizSameAsStore ? form.address : form.biz_address}
                  onChange={e => set("biz_address", e.target.value)}
                  disabled={bizSameAsStore}
                  className="w-full input-md disabled:bg-gray-50 disabled:text-gray-400"
                  placeholder="예) 서울시 중구 을지로 456" />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-medium text-gray-500 mb-1">업태</label>
                  <input type="text" value={form.business_type}
                    onChange={e => set("business_type", e.target.value)}
                    className="w-full input-md"
                    placeholder="예) 도매,소매" />
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-500 mb-1">종목</label>
                  <input type="text" value={form.business_category}
                    onChange={e => set("business_category", e.target.value)}
                    className="w-full input-md"
                    placeholder="예) 의류" />
                </div>
              </div>
              <p className="text-xs text-gray-400 -mt-2">사업자등록증의 업태/종목 — 영수증 헤더에 표시됩니다.</p>
              <div className="pt-4 mt-4 border-t border-gray-100">
                <label className="block text-xs font-medium text-gray-500 mb-1">부가세율</label>
                <div className="flex items-center gap-2">
                  <input
                    type="number"
                    min={0} max={100} step={0.1}
                    value={Number((form.vat_rate * 100).toFixed(2))}
                    onChange={e => set("vat_rate", Math.max(0, Math.min(1, Number(e.target.value) / 100)))}
                    className="w-24 input-md"
                  />
                  <span className="text-sm text-gray-500">%</span>
                  <span className="text-xs text-gray-400 ml-2">기본 10% — 향후 정책 변경 시 수정</span>
                </div>
              </div>
            </div>
          </section>

          <section className="bg-white rounded-xl border border-gray-200 p-6">
            <h2 className="text-sm font-semibold text-gray-700 mb-1">입금 받을 계좌</h2>
            <p className="text-xs text-gray-400 mb-4">소매 거래처가 입금할 때 안내되는 계좌입니다.</p>
            <div className="space-y-5">
              <div>
                <p className="text-xs font-semibold text-gray-500 mb-2">메인 계좌</p>
                <div className="grid grid-cols-3 gap-2">
                  <input type="text" value={form.main_bank_name}
                    onChange={e => set("main_bank_name", e.target.value)}
                    className="input-md"
                    placeholder="은행 (예: 국민)" />
                  <input type="text" value={form.main_bank_account}
                    onChange={e => set("main_bank_account", e.target.value)}
                    className="input-md"
                    placeholder="계좌번호" />
                  <input type="text" value={form.main_bank_holder}
                    onChange={e => set("main_bank_holder", e.target.value)}
                    className="input-md"
                    placeholder="예금주" />
                </div>
              </div>
              <div>
                <p className="text-xs font-semibold text-gray-500 mb-2">서브 계좌 <span className="text-gray-300 font-normal">(선택)</span></p>
                <div className="grid grid-cols-3 gap-2">
                  <input type="text" value={form.sub_bank_name}
                    onChange={e => set("sub_bank_name", e.target.value)}
                    className="input-md"
                    placeholder="은행" />
                  <input type="text" value={form.sub_bank_account}
                    onChange={e => set("sub_bank_account", e.target.value)}
                    className="input-md"
                    placeholder="계좌번호" />
                  <input type="text" value={form.sub_bank_holder}
                    onChange={e => set("sub_bank_holder", e.target.value)}
                    className="input-md"
                    placeholder="예금주" />
                </div>
              </div>
            </div>
          </section>

          <section className="bg-white rounded-xl border border-gray-200 p-6">
            <h2 className="text-sm font-semibold text-gray-700 mb-4">샘플 설정</h2>
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1">샘플 제공 기간</label>
              <div className="flex items-center gap-2">
                <input type="number" min={1} max={365} value={form.sample_period_days}
                  onChange={e => set("sample_period_days", Number(e.target.value))}
                  className="w-24 input-md text-center" />
                <span className="text-sm text-gray-500">일</span>
              </div>
              <p className="text-xs text-gray-400 mt-1">샘플 출고 후 반납 또는 구매 전환까지의 기본 기간</p>
            </div>
          </section>

        </div>
      )}

      {tab === "info" && (
        <PageActionBar>
          {saved && <span className="text-sm text-green-600">저장되었습니다.</span>}
          <Button size="lg" onClick={handleSaveInfo} disabled={saving}>
            {saving ? "저장 중..." : "저장"}
          </Button>
        </PageActionBar>
      )}

      {/* ── 구독 관리 탭 ── (사장만) */}
      {tab === "subscription" && isAdmin && (
        <div className="space-y-6">
          <p className="text-xs text-gray-600 font-medium">이 탭은 사장님만 볼 수 있습니다.</p>

          {/* 현재 구독 정보 */}
          <section className="bg-white rounded-xl border border-gray-200 p-6">
            <h2 className="text-sm font-semibold text-gray-700 mb-4">현재 구독</h2>
            {currentPlan ? (
              <div className="space-y-4">
                {/* 취소 예약 안내 배너 */}
                {isCancelScheduled && (
                  <div className="flex items-center gap-2 px-4 py-2.5 bg-orange-50 border border-orange-200 rounded-lg text-sm text-orange-700">
                    <span>⚠</span>
                    <span>구독 취소가 예약되었습니다. <strong>{formatDate(tenantSub.subscription_expires_at ?? "")}</strong>에 자동 해지됩니다.</span>
                  </div>
                )}

                <div className="flex items-start justify-between">
                  <div>
                    <div className="flex items-center gap-2 mb-1">
                      <span className="text-base font-bold text-gray-900">{currentPlan.name}</span>
                      {isExpired ? (
                        <span className="text-xs px-2 py-0.5 bg-red-100 text-red-600 rounded-full">만료됨</span>
                      ) : isCancelScheduled ? (
                        <span className="text-xs px-2 py-0.5 bg-orange-100 text-orange-600 rounded-full">취소 예약됨</span>
                      ) : (
                        <span className="text-xs px-2 py-0.5 bg-green-100 text-green-600 rounded-full">구독 중</span>
                      )}
                    </div>
                    {currentPlan.description && (
                      <p className="text-sm text-gray-500 mb-2">{currentPlan.description}</p>
                    )}
                    {tenantSub.subscription_expires_at && (
                      <p className="text-xs text-gray-400">
                        {isExpired ? "만료일" : isCancelScheduled ? "해지 예정일" : "다음 갱신일"}: {formatDate(tenantSub.subscription_expires_at)}
                      </p>
                    )}
                    {currentPlan.features.length > 0 && (
                      <ul className="mt-3 space-y-1">
                        {currentPlan.features.map((f, i) => (
                          <li key={i} className="flex items-center gap-1.5 text-sm text-gray-600">
                            <span className="text-green-500 text-xs">✓</span>{f}
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                  <div className="text-right shrink-0 ml-4">
                    <span className="text-xl font-bold text-gray-900">{krw(currentPlan.price)}</span>
                    <span className="text-xs text-gray-400 ml-1">/ {BILLING_LABEL[currentPlan.billing_cycle] ?? currentPlan.billing_cycle}</span>
                  </div>
                </div>

                {/* 취소 / 취소철회 버튼 */}
                {!isExpired && (
                  <div className="pt-2 border-t border-gray-100">
                    <button
                      onClick={handleCancelToggle}
                      disabled={cancelling}
                      className={`text-xs px-3 py-1.5 rounded-lg border transition-colors disabled:opacity-50 ${
                        isCancelScheduled
                          ? "border-green-300 text-green-600 hover:bg-green-50"
                          : "border-red-200 text-red-400 hover:bg-red-50"
                      }`}>
                      {cancelling ? "처리 중..." : isCancelScheduled ? "구독 취소 철회" : "구독 취소"}
                    </button>
                  </div>
                )}
              </div>
            ) : (
              <p className="text-sm text-gray-400">구독 중인 플랜이 없습니다. 아래에서 플랜을 선택해주세요.</p>
            )}
          </section>

          {/* 플랜 목록 */}
          <section>
            <h2 className="text-sm font-semibold text-gray-700 mb-3">이용 가능한 플랜</h2>
            {plans.length === 0 ? (
              <div className="bg-white rounded-xl border border-gray-200 p-8 text-center text-sm text-gray-400">
                등록된 플랜이 없습니다.
              </div>
            ) : (
              <div className="space-y-3">
                {plans.map(plan => {
                  const isCurrent = plan.id === tenantSub.plan_id;
                  return (
                    <div key={plan.id}
                      className={`bg-white rounded-xl border-2 p-5 transition-colors ${
                        isCurrent ? "border-primary-ring bg-primary-soft" : "border-gray-200"
                      }`}>
                      <div className="flex items-start justify-between gap-4">
                        <div className="flex-1">
                          <div className="flex items-center gap-2 mb-1">
                            <span className="font-bold text-gray-900">{plan.name}</span>
                            {isCurrent && (
                              <span className="text-xs px-2 py-0.5 bg-primary-soft-hover text-primary rounded-full">현재 플랜</span>
                            )}
                          </div>
                          {plan.description && (
                            <p className="text-xs text-gray-500 mb-2">{plan.description}</p>
                          )}
                          {plan.features.length > 0 && (
                            <ul className="flex flex-wrap gap-x-4 gap-y-1">
                              {plan.features.map((f, i) => (
                                <li key={i} className="flex items-center gap-1 text-xs text-gray-600">
                                  <span className="text-green-500">✓</span>{f}
                                </li>
                              ))}
                            </ul>
                          )}
                        </div>
                        <div className="shrink-0 flex flex-col items-end gap-2">
                          <div className="text-right">
                            <span className="text-lg font-bold text-gray-900">{krw(plan.price)}</span>
                            <span className="text-xs text-gray-400 ml-1">/ {BILLING_LABEL[plan.billing_cycle] ?? plan.billing_cycle}</span>
                          </div>
                          {isCurrent ? (
                            <span className="text-xs text-primary-ring font-medium">구독 중</span>
                          ) : (
                            <Button size="sm" onClick={() => handleSubscribe(plan)} disabled={subscribing === plan.id}>
                              {subscribing === plan.id ? "처리 중..." : "구독하기"}
                            </Button>
                          )}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </section>
        </div>
      )}
    </div>
  );
}
