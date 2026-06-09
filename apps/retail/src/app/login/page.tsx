"use client";

import { Suspense } from "react";
import { useSearchParams } from "next/navigation";
import LoginForm from "@/components/auth/LoginForm";

// retail tenant 사장의 내부 관리 진입점 — /samples /products 로 이동.
// /order 의 외부 주문 포털 진입점과 같은 cookie + 같은 tenant 공유.
function LoginInner() {
  const search = useSearchParams();
  const redirect = search.get("redirect") ?? "/samples";
  return (
    <LoginForm
      redirect={redirect}
      signupHref="/signup"
      subtitle="내 매장의 샘플과 상품을 관리합니다"
    />
  );
}

export default function LoginPage() {
  return (
    <main className="min-h-screen flex items-start justify-center bg-gradient-to-br from-gray-50 to-gray-100 px-4 pt-[14vh] pb-10">
      <Suspense fallback={<div className="text-xs text-gray-400">…</div>}>
        <LoginInner />
      </Suspense>
    </main>
  );
}
