"use client";

import { styles } from "@/common/styles";
import { useTenant } from "@/lib/TenantContext";
import StylingSheet from "@/components/styling/StylingSheet";

// 스타일링 탭 — 코디 → [주문서로](샘플요청) → 입고 시 샘플 탭 등록. 마이그 242.
export default function StylingPage() {
  const { tenant } = useTenant();

  return (
    <main className={styles.mainWide}>
      {!tenant?.id ? (
        <div className="text-xs text-gray-400">불러오는 중…</div>
      ) : (
        <StylingSheet tenantId={tenant.id} />
      )}
    </main>
  );
}
