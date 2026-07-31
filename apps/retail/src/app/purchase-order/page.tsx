"use client";

import { styles } from "@/common/styles";
import { useTenant } from "@/lib/TenantContext";

// 주문(사입 발주) 탭 — 언타일 상품↔사입상품 매칭 주문장 작성용. 빈 페이지, 다음 라운드 설계.
export default function PurchaseOrderPage() {
  const { tenant } = useTenant();

  return (
    <main className={styles.mainWide}>
      {!tenant?.id ? (
        <div className="text-xs text-gray-400">불러오는 중…</div>
      ) : (
        <div className={styles.cardSm + " text-xs text-gray-400"}>준비 중이에요.</div>
      )}
    </main>
  );
}
