"use client";

import { styles } from "@/common/styles";
import { useTenant } from "@/lib/TenantContext";

// 회계 탭 — 재설계 중. DB 스키마부터 다시 논의 후 기능을 채운다.
export default function AccountingPage() {
  const { tenant } = useTenant();

  return (
    <main className={styles.main}>
      {!tenant?.id ? (
        <div className="text-xs text-gray-400">불러오는 중…</div>
      ) : (
        <div className="text-sm text-gray-400">회계 — 설계 중입니다.</div>
      )}
    </main>
  );
}
