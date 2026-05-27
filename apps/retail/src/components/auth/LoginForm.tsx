"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { isValidPhone, isValidPin } from "@/lib/orderPortal";
import { styles } from "@/common/styles";
import { usePlatformSettings } from "@/lib/usePlatformSettings";
import BusinessInfoFooter from "@/components/BusinessInfoFooter";

// 공용 로그인 폼 — /order 와 /login 양쪽에서 재사용.
// 인증 = /api/order-portal/login (sb-retail-auth cookie). 두 진입점 같은 cookie 공유.
// 차이점은 redirect 만. props 로 박제.

interface Props {
  redirect: string;       // 로그인 성공 후 이동할 URL
  signupHref: string;     // "회원가입" 링크 (/signup 또는 /order/signup)
  subtitle?: string;      // 박스 부제 (예: "휴대폰 번호로 도매에 주문을 보내세요")
}

export default function LoginForm({ redirect, signupHref, subtitle }: Props) {
  const router = useRouter();
  const settings = usePlatformSettings();
  const [phone, setPhone] = useState("");
  const [pin, setPin] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!isValidPhone(phone)) {
      setError("휴대폰 번호를 정확히 입력해주세요 (010-XXXX-XXXX).");
      return;
    }
    if (!isValidPin(pin)) {
      setError("비밀번호는 숫자 4자리로 입력해주세요.");
      return;
    }
    const res = await fetch("/api/order-portal/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ phone, pin }),
    });
    const json = (await res.json().catch(() => ({}))) as { error?: string };
    if (!res.ok) {
      setError(json.error ?? "로그인에 실패했습니다.");
      return;
    }
    startTransition(() => router.push(redirect));
  }

  return (
    <div className="w-full max-w-md">
      <div className="bg-white rounded-2xl shadow-lg border border-gray-100 p-8">
        <div className="text-center mb-6">
          <div className="inline-flex w-12 h-12 rounded-xl bg-primary text-white items-center justify-center text-lg font-bold mb-2">
            {settings?.service_brand_letter ?? ""}
          </div>
          <h1 className="text-2xl font-bold text-gray-900">로그인</h1>
          {subtitle && <p className="text-sm text-gray-500 mt-1">{subtitle}</p>}
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className={styles.formLabel}>휴대폰</label>
            <input
              type="tel"
              inputMode="numeric"
              value={phone}
              onChange={e => setPhone(e.target.value)}
              required
              autoFocus
              autoComplete="username"
              placeholder="010-1234-5678"
              className={styles.inputLg}
            />
          </div>
          <div>
            <label className={styles.formLabel}>비밀번호 (숫자 4자리)</label>
            <input
              type="password"
              inputMode="numeric"
              maxLength={4}
              value={pin}
              onChange={e => setPin(e.target.value.replace(/\D/g, ""))}
              required
              autoComplete="current-password"
              placeholder="••••"
              className={styles.inputLg}
            />
            {error && (
              <div className="flex items-start gap-1.5 text-sm text-red-600 mt-1.5">
                <span className="leading-none mt-0.5">⚠</span>
                <span>{error}</span>
              </div>
            )}
          </div>

          <button type="submit" disabled={pending}
            className={`${styles.btnPrimary} w-full py-2.5 font-medium flex items-center justify-center gap-2`}>
            {pending ? "로그인 중..." : "로그인"}
          </button>

          <div className="pt-4 mt-2 border-t border-gray-100 text-center">
            <span className="text-sm text-gray-500">처음이세요? </span>
            <Link href={signupHref} className="text-sm text-primary hover:underline font-medium">
              회원가입 →
            </Link>
          </div>
        </form>
      </div>
      <BusinessInfoFooter />
    </div>
  );
}
