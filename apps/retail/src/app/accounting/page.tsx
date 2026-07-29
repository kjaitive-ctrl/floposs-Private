"use client";

import { styles } from "@/common/styles";
import { useTenant } from "@/lib/TenantContext";
import CashMatrix from "@/components/accounting/CashMatrix";

// 회계 탭 — 재설계 1단계: 입출금 매트릭스. 전표/후처리 화면은 다음 라운드. 마이그 225.
export default function AccountingPage() {
  const { tenant } = useTenant();

  return (
    <main className={styles.mainWide}>
      {!tenant?.id ? (
        <div className="text-xs text-gray-400">불러오는 중…</div>
      ) : (
        <CashMatrix tenantId={tenant.id} />
      )}
    </main>
  );
}
