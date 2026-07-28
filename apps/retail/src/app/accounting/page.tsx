"use client";

import { Suspense, useState } from "react";
import { useSearchParams } from "next/navigation";
import { styles } from "@/common/styles";
import { useTenant } from "@/lib/TenantContext";
import MatrixLedger from "@/components/accounting/MatrixLedger";
import TransactionLedger from "@/components/accounting/TransactionLedger";
import PnlReport from "@/components/accounting/PnlReport";
import VendorAnalysis from "@/components/accounting/VendorAnalysis";
import CategoryManager from "@/components/accounting/CategoryManager";

// 회계 장부 — 거래입력(기본=매트릭스) / 손익리포트 / 거래처분석 / 계정과목. 마이그 218/219.
type Tab = "ledger" | "pnl" | "vendor" | "category";
const TABS: [Tab, string][] = [["ledger", "거래입력"], ["pnl", "손익리포트"], ["vendor", "거래처분석"], ["category", "계정과목"]];

function AccountingInner() {
  const { tenant } = useTenant();
  const sp = useSearchParams();
  const initial = sp.get("tab") as Tab | null;
  const [tab, setTab] = useState<Tab>(initial && TABS.some(([k]) => k === initial) ? initial : "ledger");
  // 매트릭스=반복 거래(거래처 고정, 매달 계속 뜸) / 리스트=예외·일회성 거래(대납 등). 마이그 219 설계.
  const [ledgerView, setLedgerView] = useState<"matrix" | "list">("matrix");

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
      {tab === "ledger" && (
        <>
          <div className="flex items-center gap-1 mb-3">
            <button type="button" onClick={() => setLedgerView("matrix")}
              className={ledgerView === "matrix" ? styles.btnSmall : styles.btnSmallGhost}>매트릭스 (반복거래)</button>
            <button type="button" onClick={() => setLedgerView("list")}
              className={ledgerView === "list" ? styles.btnSmall : styles.btnSmallGhost}>리스트 (예외·일회성)</button>
          </div>
          {ledgerView === "matrix" ? <MatrixLedger tenantId={tenant.id} /> : <TransactionLedger tenantId={tenant.id} />}
        </>
      )}
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
