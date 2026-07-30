"use client";

import { useState } from "react";
import { styles } from "@/common/styles";
import { useTenant } from "@/lib/TenantContext";
import { monthRange } from "@/lib/accounting";
import CashMatrix from "@/components/accounting/CashMatrix";
import JournalPanel from "@/components/accounting/JournalPanel";
import AccountSettingsPanel from "@/components/accounting/AccountSettingsPanel";

const TABS = [
  { key: "matrix", label: "입출금" },
  { key: "journal", label: "전표" },
  { key: "settings", label: "설정" },
] as const;
type TabKey = (typeof TABS)[number]["key"];

// 회계 탭 — 입출금 매트릭스 / 전표(자동+수동, 마이그 229) / 설정(계정과목,
// 마이그 230)을 탭으로 분리. 매트릭스·전표는 같은 달(anchor)을 공유.
export default function AccountingPage() {
  const { tenant } = useTenant();
  const [anchor, setAnchor] = useState(() => new Date());
  const [tab, setTab] = useState<TabKey>("matrix");
  const { fromIso, toIso, label } = monthRange(anchor);

  return (
    <main className={styles.mainWide}>
      {!tenant?.id ? (
        <div className="text-xs text-gray-400">불러오는 중…</div>
      ) : (
        <>
          <div className="flex items-center gap-1 mb-4 border-b border-gray-200">
            {TABS.map(t => (
              <button key={t.key} type="button" onClick={() => setTab(t.key)}
                className={tab === t.key ? styles.navLinkActive : styles.navLink}>
                {t.label}
              </button>
            ))}
          </div>
          {tab === "matrix" && <CashMatrix tenantId={tenant.id} anchor={anchor} onAnchorChange={setAnchor} />}
          {tab === "journal" && <JournalPanel tenantId={tenant.id} fromIso={fromIso} toIso={toIso} label={label} />}
          {tab === "settings" && <AccountSettingsPanel tenantId={tenant.id} />}
        </>
      )}
    </main>
  );
}
