"use client";

import { Suspense, useState } from "react";
import { useSearchParams } from "next/navigation";
import { styles } from "@/common/styles";
import { useTenant } from "@/lib/TenantContext";
import MatrixLedger from "@/components/accounting/MatrixLedger";
import PnlReport from "@/components/accounting/PnlReport";
import VendorAnalysis from "@/components/accounting/VendorAnalysis";
import CategoryManager from "@/components/accounting/CategoryManager";
import JournalView from "@/components/accounting/JournalView";

// 회계 장부 — 거래입력(매트릭스 단일) / 전표 / 손익리포트 / 거래처분석 / 계정과목. 마이그 218/219/221/222.
// 반복거래/예외 구분 없음 — 거래처 행이 월과 무관하게 영속하므로(전월 양식 자동 유지),
// 필요 없어진 행은 사용자가 ×로 직접 제거. 리스트(예외·일회성) 뷰는 폐기.
type Tab = "ledger" | "journal" | "pnl" | "vendor" | "category";
const TABS: [Tab, string][] = [["ledger", "거래입력"], ["journal", "전표"], ["pnl", "손익리포트"], ["vendor", "거래처분석"], ["category", "계정과목"]];

function AccountingInner() {
  const { tenant } = useTenant();
  const sp = useSearchParams();
  const initial = sp.get("tab") as Tab | null;
  const [tab, setTab] = useState<Tab>(initial && TABS.some(([k]) => k === initial) ? initial : "ledger");

  if (!tenant?.id) return <div className="text-xs text-gray-400">불러오는 중…</div>;

  return (
    <>
      <div className="flex items-center gap-5 border-b border-gray-200 mb-4">
        {TABS.map(([k, label]) => (
          <button key={k} type="button" onClick={() => setTab(k)}
            className={"pb-2 -mb-px text-lg font-bold border-b-2 transition-colors " +
              (tab === k ? "border-black text-black" : "border-transparent text-gray-300 hover:text-gray-500")}>
            {label}
          </button>
        ))}
      </div>
      {tab === "ledger" && <MatrixLedger tenantId={tenant.id} />}
      {tab === "journal" && <JournalView tenantId={tenant.id} />}
      {tab === "pnl" && <PnlReport tenantId={tenant.id} />}
      {tab === "vendor" && <VendorAnalysis tenantId={tenant.id} />}
      {tab === "category" && <CategoryManager tenantId={tenant.id} />}
    </>
  );
}

export default function AccountingPage() {
  return (
    <main className={styles.mainWide}>
      <Suspense fallback={<div className="text-xs text-gray-400">…</div>}>
        <AccountingInner />
      </Suspense>
    </main>
  );
}
