"use client";

import { styles } from "@/common/styles";
import { useTenant } from "@/lib/TenantContext";
import TrendBoard from "@/components/trends/TrendBoard";
import FreeSheet from "@/components/common/FreeSheet";

// 트렌드 탭 — 시즌(열)별 트렌드 키워드 시트. 마이그 240.
export default function TrendsPage() {
  const { tenant } = useTenant();

  return (
    <main className={styles.mainWide}>
      {!tenant?.id ? (
        <div className="text-xs text-gray-400">불러오는 중…</div>
      ) : (
        <>
          <TrendBoard tenantId={tenant.id} />
          <div className="mt-10">
            <FreeSheet tenantId={tenant.id} sheetKey="trend_memo" title="메모" />
          </div>
        </>
      )}
    </main>
  );
}
