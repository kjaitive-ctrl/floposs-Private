"use client";

import { useState } from "react";
import { styles } from "@/common/styles";
import { useTenant } from "@/lib/TenantContext";
import { monthRange } from "@/lib/accounting";
import CashMatrix from "@/components/accounting/CashMatrix";
import JournalPanel from "@/components/accounting/JournalPanel";

// 회계 탭 — 입출금 매트릭스 + 전표(자동+수동, 마이그 229). 두 패널이 같은
// 달(anchor)을 공유해야 해서 여기서 한 번만 상태로 들고 내려줌.
export default function AccountingPage() {
  const { tenant } = useTenant();
  const [anchor, setAnchor] = useState(() => new Date());
  const { fromIso, toIso, label } = monthRange(anchor);

  return (
    <main className={styles.mainWide}>
      {!tenant?.id ? (
        <div className="text-xs text-gray-400">불러오는 중…</div>
      ) : (
        <div className="space-y-4">
          <CashMatrix tenantId={tenant.id} anchor={anchor} onAnchorChange={setAnchor} />
          <JournalPanel tenantId={tenant.id} fromIso={fromIso} toIso={toIso} label={label} />
        </div>
      )}
    </main>
  );
}
