"use client";

import { useRouter } from "next/navigation";
import { useTenant } from "@/lib/useTenant";
import SaleForm, { type SavedOrder } from "../../_components/SaleForm";

export default function NewSalePage() {
  const router = useRouter();
  const tenant = useTenant();
  const tenantId = tenant?.id ?? null;
  const tenantCode = tenant?.tenantCode ?? "";

  function handleSaveSuccess(_order: SavedOrder) {
    router.push("/dashboard/orders-test?tab=product&refresh=" + Date.now());
  }

  return (
    <div className="-m-8 flex flex-col" style={{ height: "100vh" }}>

      {/* 헤더 */}
      <div className="px-5 py-3 bg-white border-b border-gray-200 shrink-0 flex items-center gap-3">
        <button onClick={() => router.back()} className="text-gray-400 hover:text-gray-600 text-sm">← 뒤로</button>
        <h2 className="text-lg font-bold text-gray-900">주문 등록</h2>
      </div>

      {/* 판매 폼 */}
      {tenantId && (
        <SaleForm tenantId={tenantId} tenantCode={tenantCode} onSaveSuccess={handleSaveSuccess} />
      )}
    </div>
  );
}
