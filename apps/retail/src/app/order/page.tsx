"use client";

import { Suspense } from "react";
import { useSearchParams } from "next/navigation";
import LoginForm from "@/components/auth/LoginForm";

// 외부 주문 포털 진입점 — /order/browse 로 이동.
// /login (내부 관리) 와 같은 cookie + 같은 tenant 공유. UI 동일, redirect 만 다름.
function OrderLoginInner() {
  const search = useSearchParams();
  const redirect = search.get("redirect") ?? "/order/browse";
  return (
    <LoginForm
      redirect={redirect}
      signupHref="/order/signup"
      subtitle="휴대폰 번호로 도매에 주문을 보내세요"
    />
  );
}

export default function OrderLoginPage() {
  return (
    <main className="min-h-screen flex items-center justify-center bg-gradient-to-br from-gray-50 to-gray-100 px-4 py-10">
      <Suspense fallback={<div className="text-xs text-gray-400">…</div>}>
        <OrderLoginInner />
      </Suspense>
    </main>
  );
}
