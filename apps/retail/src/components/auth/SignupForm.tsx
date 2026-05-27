"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { isValidPhone, isValidPin, type PaymentMethod } from "@/lib/orderPortal";
import { styles } from "@/common/styles";

// retail v2 가입 폼 (마이그 189).
// 라벨: 업체명(=company_name), 사무실주소(=address), 사장님 연락처(=phone)
// 신규: 세금계산서 이메일 / 담당자 이메일 / 물류주소(체크) / 물류연락처 / 쇼핑몰명 / 쇼핑몰 URL

interface Props {
  redirect: string;       // 가입 성공 후 이동할 URL
  loginHref: string;      // "로그인" 링크
  subtitle?: string;
}

export default function SignupForm({ redirect, loginHref, subtitle }: Props) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  // 기본
  const [phone, setPhone] = useState("");
  const [pin, setPin] = useState("");
  const [pinConfirm, setPinConfirm] = useState("");
  const [companyName, setCompanyName] = useState("");
  const [address, setAddress] = useState("");
  const [representativePhone, setRepresentativePhone] = useState("");
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>("credit");
  // 마이그 189 신규
  const [taxInvoiceEmail, setTaxInvoiceEmail] = useState("");
  const [contactEmail, setContactEmail] = useState("");
  const [warehouseSame, setWarehouseSame] = useState(true);
  const [warehouseAddress, setWarehouseAddress] = useState("");
  const [warehousePhone, setWarehousePhone] = useState("");
  const [storeName, setStoreName] = useState("");
  const [storeUrl, setStoreUrl] = useState("");

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!isValidPhone(phone))    { setError("휴대폰 번호를 정확히 입력해주세요 (010-XXXX-XXXX)."); return; }
    if (!isValidPin(pin))        { setError("비밀번호는 숫자 4자리로 설정해주세요."); return; }
    if (pin !== pinConfirm)      { setError("비밀번호가 일치하지 않습니다."); return; }
    if (!companyName.trim())     { setError("업체명을 입력해주세요."); return; }

    const res = await fetch("/api/order-portal/signup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        phone, pin,
        company_name: companyName,
        address,
        representative_phone: representativePhone,
        default_payment_method: paymentMethod,
        tax_invoice_email: taxInvoiceEmail,
        contact_email: contactEmail,
        warehouse_same_as_office: warehouseSame,
        warehouse_address: warehouseSame ? "" : warehouseAddress,
        warehouse_phone: warehousePhone,
        store_name: storeName,
        store_url: storeUrl,
      }),
    });
    const json = (await res.json().catch(() => ({}))) as { error?: string };
    if (!res.ok) { setError(json.error ?? "가입에 실패했습니다."); return; }

    // 가입 성공 → 자동 로그인
    const loginRes = await fetch("/api/order-portal/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ phone, pin }),
    });
    if (!loginRes.ok) {
      startTransition(() => router.push(loginHref));
      return;
    }
    startTransition(() => router.push(redirect));
  }

  const inputClass = styles.inputLg;
  const labelClass = styles.formLabel;
  const sectionLabel = styles.sectionHeader;

  return (
    <div className="w-full max-w-md">
      <div className="bg-white rounded-2xl shadow-lg border border-gray-100 p-8">
        <div className="text-center mb-6">
          <div className="inline-flex w-12 h-12 rounded-xl bg-black text-white items-center justify-center text-lg font-bold mb-2">
            F
          </div>
          <h1 className="text-2xl font-bold text-gray-900">간편 가입</h1>
          {subtitle && <p className="text-sm text-gray-500 mt-1">{subtitle}</p>}
        </div>

        <form onSubmit={handleSubmit} className="space-y-3">
          {/* ── 계정 ── */}
          <div>
            <label className={labelClass}>휴대폰 (아이디)</label>
            <input type="tel" inputMode="numeric" required
              placeholder="010-1234-5678" value={phone}
              onChange={e => setPhone(e.target.value)}
              className={inputClass} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={labelClass}>비밀번호 (4자리)</label>
              <input type="password" inputMode="numeric" maxLength={4} required
                value={pin}
                onChange={e => setPin(e.target.value.replace(/\D/g, ""))}
                className={inputClass} />
            </div>
            <div>
              <label className={labelClass}>비밀번호 확인</label>
              <input type="password" inputMode="numeric" maxLength={4} required
                value={pinConfirm}
                onChange={e => setPinConfirm(e.target.value.replace(/\D/g, ""))}
                className={inputClass} />
            </div>
          </div>

          {/* ── 업체 정보 ── */}
          <div className={sectionLabel}>업체 정보</div>
          <div>
            <label className={labelClass}>업체명 (사업자등록증 상호)</label>
            <input type="text" required
              value={companyName}
              onChange={e => setCompanyName(e.target.value)}
              className={inputClass} />
          </div>
          <div>
            <label className={labelClass}>사무실주소</label>
            <input type="text"
              value={address}
              onChange={e => setAddress(e.target.value)}
              className={inputClass} />
          </div>
          <div>
            <label className={labelClass}>사장님 연락처</label>
            <input type="tel" placeholder="사장님 휴대폰 (선택)"
              value={representativePhone}
              onChange={e => setRepresentativePhone(e.target.value)}
              className={inputClass} />
          </div>

          {/* ── 이메일 ── */}
          <div className={sectionLabel}>이메일</div>
          <div>
            <label className={labelClass}>세금계산서 발행용</label>
            <input type="email" placeholder="tax@example.com"
              value={taxInvoiceEmail}
              onChange={e => setTaxInvoiceEmail(e.target.value)}
              className={inputClass} />
          </div>
          <div>
            <label className={labelClass}>담당자용</label>
            <input type="email" placeholder="manager@example.com"
              value={contactEmail}
              onChange={e => setContactEmail(e.target.value)}
              className={inputClass} />
          </div>

          {/* ── 물류/매장 ── */}
          <div className={sectionLabel}>물류 / 매장</div>
          <div>
            <label className="flex items-center gap-2 text-sm text-gray-700 mb-2">
              <input type="checkbox" checked={warehouseSame}
                onChange={e => setWarehouseSame(e.target.checked)}
                className="rounded" />
              사무실 주소와 동일
            </label>
            {!warehouseSame && (
              <input type="text" placeholder="물류/매장 주소"
                value={warehouseAddress}
                onChange={e => setWarehouseAddress(e.target.value)}
                className={inputClass} />
            )}
          </div>
          <div>
            <label className={labelClass}>물류/매장 연락처</label>
            <input type="tel" placeholder="현장 연락처 (선택)"
              value={warehousePhone}
              onChange={e => setWarehousePhone(e.target.value)}
              className={inputClass} />
          </div>

          {/* ── 쇼핑몰 ── */}
          <div className={sectionLabel}>쇼핑몰 / 매장</div>
          <div>
            <label className={labelClass}>쇼핑몰/매장명</label>
            <input type="text" placeholder="고객에게 보이는 이름 (브랜드명)"
              value={storeName}
              onChange={e => setStoreName(e.target.value)}
              className={inputClass} />
          </div>
          <div>
            <label className={labelClass}>쇼핑몰 주소 (URL)</label>
            <input type="url" placeholder="https://..."
              value={storeUrl}
              onChange={e => setStoreUrl(e.target.value)}
              className={inputClass} />
          </div>

          {/* ── 결제 ── */}
          <div className={sectionLabel}>결제</div>
          <div>
            <label className={labelClass}>기본 결제수단</label>
            <select value={paymentMethod}
              onChange={e => setPaymentMethod(e.target.value as PaymentMethod)}
              className={inputClass}>
              <option value="cash">현금</option>
              <option value="transfer">계좌이체</option>
              <option value="credit">외상(청구)</option>
            </select>
            <p className="text-[11px] text-gray-500 mt-1">
              가입 후 변경 불가. 도매 매장과 약속한 결제수단으로 선택해주세요.
            </p>
          </div>

          {error && (
            <div className="flex items-start gap-1.5 text-sm text-red-600 mt-1">
              <span className="leading-none mt-0.5">⚠</span>
              <span>{error}</span>
            </div>
          )}

          <button type="submit" disabled={pending}
            className={`${styles.btnPrimary} w-full py-2.5 font-medium mt-2`}>
            {pending ? "가입 중..." : "가입하고 시작하기"}
          </button>

          <div className="pt-4 mt-2 border-t border-gray-100 text-center">
            <span className="text-sm text-gray-500">이미 가입하셨나요? </span>
            <Link href={loginHref} className="text-sm text-black hover:underline font-medium">
              로그인 →
            </Link>
          </div>
        </form>
      </div>
    </div>
  );
}
