"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { styles } from "@/common/styles";
import { supabase } from "@/lib/supabase";
import type { PaymentMethod } from "@/lib/orderPortal";
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
  const [address, setAddress] = useState("");
  const [phone, setPhone] = useState("");
  const [taxInvoiceEmail, setTaxInvoiceEmail] = useState("");
  const [contactEmail, setContactEmail] = useState("");
  const [warehouseSame, setWarehouseSame] = useState(true);
  const [warehouseAddress, setWarehouseAddress] = useState("");
  const [warehousePhone, setWarehousePhone] = useState("");
  const [storeName, setStoreName] = useState("");
  const [storeUrl, setStoreUrl] = useState("");

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
      const { data, error: fetchError } = await supabase
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
        .single();
      if (cancelled) return;
      if (fetchError || !data) {
        setError(fetchError?.message ?? "정보를 불러오지 못했습니다.");
      } else {
        const t = data as unknown as MeTenant;
        setTenant(t);
        setCompanyName(t.company_name ?? "");
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
        owner_name: companyName,
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

  const daysLeft = daysUntil(tenant?.subscription_expires_at ?? null);
  const plan = tenant?.subscription_plans;

  return (
    <main className={styles.main}>
      <div className="max-w-2xl mx-auto">
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
            {/* ── 구독 카드 ── */}
            <div className={`${styles.card} mb-4`}>
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
                </div>
              ) : (
                <div className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded px-3 py-2">
                  구독 플랜이 설정되지 않았습니다. 관리자에게 문의해주세요.
                </div>
              )}
            </div>

            {/* ── 내정보 폼 ── */}
            <form onSubmit={handleSave} className={`${styles.card} space-y-4`}>
              <h2 className="text-sm font-bold text-black mb-1">내정보</h2>

              {/* 업체 */}
              <div className={styles.modalSection}>업체</div>
              <div>
                <label className={styles.modalLabel}>업체명 (사업자등록증 상호)</label>
                <input className={styles.modalInput} required
                  value={companyName} onChange={e => setCompanyName(e.target.value)} />
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
          </>
        )}
      </div>
    </main>
  );
}
