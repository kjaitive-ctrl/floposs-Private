"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { styles } from "@/common/styles";
import OrderHeader from "@/components/order/OrderHeader";
import type { PaymentMethod } from "@/lib/orderPortal";
import type { TenantBase, OutstandingTotals } from "@/lib/types";

// 마이그 189 신규 필드 없는 가벼운 버전 — base 만으로 충분
type MeTenant = TenantBase;

const PAYMENT_LABEL: Record<PaymentMethod, string> = {
  cash: "현금",
  transfer: "계좌이체",
  credit: "외상(청구)",
};

const PAYMENT_OPTIONS: { value: PaymentMethod; label: string }[] = [
  { value: "cash", label: "현금" },
  { value: "transfer", label: "계좌이체" },
  { value: "credit", label: "외상(청구)" },
];

export default function MePage() {
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [tenant, setTenant] = useState<MeTenant | null>(null);
  const [outstanding, setOutstanding] = useState<OutstandingTotals | null>(null);
  const [companyName, setCompanyName] = useState("");
  const [address, setAddress] = useState("");
  const [phone, setPhone] = useState("");
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const res = await fetch("/api/order-portal/me?include=outstanding", { cache: "no-store" });
      const json = (await res.json().catch(() => ({}))) as {
        tenant?: MeTenant;
        outstanding?: OutstandingTotals;
        error?: string;
      };
      if (cancelled) return;
      if (!res.ok || !json.tenant) {
        setError(json.error ?? "정보를 불러오지 못했습니다.");
      } else {
        setTenant(json.tenant);
        setOutstanding(json.outstanding ?? null);
        setCompanyName(json.tenant.company_name ?? "");
        setAddress(json.tenant.address ?? "");
        setPhone(json.tenant.phone ?? "");
        setPaymentMethod(json.tenant.default_payment_method);
      }
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const paymentLocked = (outstanding?.total_abs ?? 0) !== 0;

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    // 결제수단 변경 시 confirm — 변경 의미를 명확히 안내
    if (
      tenant &&
      paymentMethod &&
      paymentMethod !== tenant.default_payment_method
    ) {
      const oldLabel = tenant.default_payment_method
        ? PAYMENT_LABEL[tenant.default_payment_method]
        : "-";
      const newLabel = PAYMENT_LABEL[paymentMethod];
      const ok = window.confirm(
        `결제수단을 [${oldLabel}] → [${newLabel}] 로 변경합니다.\n\n` +
          `· 거래 중인 모든 도매 매장의 결제수단이 함께 변경됩니다.\n` +
          `· 이전 외상/매출/영수증은 그대로 유지되고, 새 거래부터 새 결제수단이 적용됩니다.\n\n` +
          `진행하시겠습니까?`
      );
      if (!ok) return;
    }

    setSaving(true);
    const res = await fetch("/api/order-portal/me", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        company_name: companyName,
        address,
        phone,
        default_payment_method: paymentMethod ?? undefined,
      }),
    });
    const json = (await res.json().catch(() => ({}))) as { tenant?: MeTenant; error?: string };

    setSaving(false);
    if (!res.ok || !json.tenant) {
      setError(json.error ?? "저장에 실패했습니다.");
      return;
    }
    setTenant(json.tenant);
    setPaymentMethod(json.tenant.default_payment_method);
    setSavedAt(Date.now());
    router.refresh();
  }

  return (
    <>
      <OrderHeader />
      <main className={styles.main}>
        <div className="max-w-md mx-auto">
          <div className="flex items-center gap-3 mb-4">
            <Link href="/order/browse" className="text-xs text-gray-500 hover:text-black">
              ← 도매 매장 목록
            </Link>
          </div>

          <h1 className="text-xl font-bold text-black mb-1">내 정보</h1>
          <p className="text-xs text-gray-500 mb-4">
            매장명·주소·사장님 연락처 수정 가능. 휴대폰(아이디)·결제수단은 정책상 변경 불가입니다.
          </p>

          {loading ? (
            <div className="text-xs text-gray-400">불러오는 중…</div>
          ) : !tenant ? (
            <div className="text-xs text-red-600">{error ?? "정보 없음"}</div>
          ) : (
            <form onSubmit={handleSave} className="bg-white border border-gray-200 rounded-2xl p-6 space-y-3">
              <div>
                <label className={styles.modalLabel}>휴대폰 (아이디)</label>
                <input className={`${styles.modalInput} bg-gray-50`} value={tenant.phone ?? ""} readOnly disabled />
                <p className="text-[11px] text-gray-400 mt-1">아이디는 변경 불가</p>
              </div>

              <div>
                <label className={styles.modalLabel}>매장명</label>
                <input
                  className={styles.modalInput}
                  value={companyName}
                  onChange={(e) => setCompanyName(e.target.value)}
                  required
                />
              </div>

              <div>
                <label className={styles.modalLabel}>매장 주소</label>
                <input
                  className={styles.modalInput}
                  value={address}
                  onChange={(e) => setAddress(e.target.value)}
                  placeholder="(선택)"
                />
              </div>

              <div>
                <label className={styles.modalLabel}>사장님 연락처</label>
                <input
                  className={styles.modalInput}
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  placeholder="(선택) 가게 전화번호"
                />
              </div>

              <div>
                <div className="flex items-center justify-between mb-1">
                  <label className={styles.modalLabel}>기본 결제수단</label>
                  {paymentLocked && (
                    <span className="px-2 py-0.5 text-[10px] font-semibold rounded bg-rose-100 text-rose-700 border border-rose-200">
                      외상 정산 후 변경 가능
                    </span>
                  )}
                </div>
                <div className="grid grid-cols-3 gap-2">
                  {PAYMENT_OPTIONS.map((opt) => {
                    const selected = paymentMethod === opt.value;
                    return (
                      <button
                        key={opt.value}
                        type="button"
                        disabled={paymentLocked}
                        onClick={() => !paymentLocked && setPaymentMethod(opt.value)}
                        className={`py-2 text-sm font-medium rounded-lg border transition-colors ${
                          selected
                            ? "bg-black text-white border-black"
                            : "bg-white text-gray-600 border-gray-300 hover:bg-gray-50"
                        } ${paymentLocked ? "opacity-50 cursor-not-allowed" : ""}`}
                      >
                        {opt.label}
                      </button>
                    );
                  })}
                </div>

                {paymentLocked ? (
                  <div className="text-[11px] text-rose-700 bg-rose-50 border border-rose-200 rounded px-2 py-1.5 mt-2 leading-relaxed">
                    현재 거래 중인 도매 매장과 <b>외상/매입 잔액</b>이 있어 결제수단을 변경할 수 없습니다.
                    {outstanding && (
                      <>
                        <br />
                        외상 합계 <b>{Math.abs(outstanding.supply).toLocaleString()}원</b>
                        {outstanding.vat !== 0 && (
                          <> · 부가세 <b>{Math.abs(outstanding.vat).toLocaleString()}원</b></>
                        )}
                      </>
                    )}
                    <br />
                    모든 거래처와 정산 (잔액 0) 후 변경 가능합니다.
                  </div>
                ) : (
                  <p className="text-[11px] text-amber-700 bg-amber-50 border border-amber-200 rounded px-2 py-1.5 mt-2 leading-relaxed">
                    결제수단을 변경하면 거래 중인 <b>모든 도매 매장</b>의 결제수단이 함께 변경됩니다.
                    이전 외상·매출·영수증은 그대로 유지되고, <b>새 거래부터</b> 새 결제수단이 적용됩니다.
                  </p>
                )}
              </div>

              {error && (
                <div className="text-xs text-red-600 bg-red-50 border border-red-200 rounded px-3 py-2">
                  {error}
                </div>
              )}

              {savedAt && !error && (
                <div className="text-xs text-emerald-700 bg-emerald-50 border border-emerald-200 rounded px-3 py-2">
                  저장되었습니다.
                </div>
              )}

              <button
                type="submit"
                disabled={saving}
                className={`${styles.btnPrimary} w-full disabled:opacity-50 mt-2`}
              >
                {saving ? "저장 중…" : "저장"}
              </button>
            </form>
          )}
        </div>
      </main>
    </>
  );
}
