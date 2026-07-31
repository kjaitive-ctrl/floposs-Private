"use client";

import { styles } from "@/common/styles";
import { useTenant } from "@/lib/TenantContext";
import OrderSheet from "@/components/purchase-order/OrderSheet";

// 주문(사입 발주) 탭 — 상품명/도매상품명/옵션/단가/수량/거래처 엑셀형 시트.
// 정식 발주(order_notes, 등록 공급사) 시스템과 별개, 가벼운 개인 시트. 마이그 231.
export default function PurchaseOrderPage() {
  const { tenant } = useTenant();

  return (
    <main className={styles.mainWide}>
      {!tenant?.id ? (
        <div className="text-xs text-gray-400">불러오는 중…</div>
      ) : (
        <OrderSheet tenantId={tenant.id} />
      )}
    </main>
  );
}
