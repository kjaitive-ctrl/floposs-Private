"use client";

import { Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { styles } from "@/common/styles";
import OrderHeader from "@/components/order/OrderHeader";

function CompleteInner() {
  const router = useRouter();
  const search = useSearchParams();
  const orderNo = search.get("no");
  const wholesale = search.get("ws");

  async function handleLogout() {
    await fetch("/api/order-portal/logout", { method: "POST" });
    router.push("/order");
    router.refresh();
  }

  return (
    <main className={styles.main}>
      <div className="max-w-md mx-auto bg-white border border-gray-200 rounded-2xl p-8 text-center">
        <div className="text-2xl font-bold text-black mb-2">주문이 전송되었습니다</div>
        {wholesale && (
          <div className="text-sm text-gray-700 mb-1">받는 도매: {wholesale}</div>
        )}
        {orderNo && (
          <div className="text-xs text-gray-500 mb-6">주문번호: {orderNo}</div>
        )}

        <div className="flex flex-col gap-2 mt-6">
          <button
            type="button"
            onClick={() => router.push("/order/browse")}
            className={`${styles.btnPrimary} w-full`}
          >
            다른 도매에 또 주문하기
          </button>
          <button
            type="button"
            onClick={handleLogout}
            className={`${styles.btnOutline} w-full`}
          >
            로그아웃
          </button>
        </div>
      </div>
    </main>
  );
}

export default function CompletePage() {
  return (
    <>
      <OrderHeader />
      <Suspense fallback={<div className={styles.main}>…</div>}>
        <CompleteInner />
      </Suspense>
    </>
  );
}
