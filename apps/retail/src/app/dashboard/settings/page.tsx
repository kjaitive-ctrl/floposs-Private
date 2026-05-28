"use client";

import { useEffect, useState } from "react";
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
};

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
      const [{ data, error: fetchError }, { data: planRows }] = await Promise.all([
        supabase
          .from("tenants")
          .select(`
            id, company_name, owner_name, phone, address, business_number, default_payment_method,
            tax_invoice_email, contact_email,
            warehouse_address, warehouse_same_as_office, warehouse_phone,
            store_name, store_url,
            plan_id, subscription_expires_at, cancel_at_period_end,
            subscription_plans(id, name, description, price, billing_cycle, features)
          `)
          .eq("id", tenantId)
          .single(),
        supabase
          .from("subscription_plans")
          .select("id, name, description, price, billing_cycle, features")
          .eq("vertical", "retail")
          .eq("is_active", true)
          .order("price", { ascending: true }),
      ]);
      if (cancelled) return;
      if (planRows) setPlans(planRows as RetailPlan[]);
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
      }
      setLoading(false);
    })();
    return () => { cancelled = true; };
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
        )}
      </div>
    </main>
  );
}
