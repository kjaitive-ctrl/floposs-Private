"use client";

import { Suspense, useState } from "react";
import { useSearchParams } from "next/navigation";
import { styles } from "@/common/styles";
import { useTenant } from "@/lib/TenantContext";
import RoutineSetup from "@/components/routines/RoutineSetup";
import ScheduleCalendar from "@/components/routines/ScheduleCalendar";

// 업무루틴 + 일정 세팅(메인). ?tab=schedule 로 일정 탭 직행(대시보드 "달력" 링크). 마이그 208.
function RoutinesInner() {
  const { tenant } = useTenant();
  const sp = useSearchParams();
  const [tab, setTab] = useState<"routine" | "schedule">(sp.get("tab") === "schedule" ? "schedule" : "routine");

  if (!tenant?.id) return <div className="text-xs text-gray-400">불러오는 중…</div>;

  const tabs: [typeof tab, string][] = [["routine", "업무루틴"], ["schedule", "일정"]];

  return (
    <>
      <div className="flex items-center gap-5 border-b border-gray-200 mb-4">
        {tabs.map(([k, label]) => (
          <button key={k} type="button" onClick={() => setTab(k)}
            className={"pb-2 -mb-px text-lg font-bold border-b-2 transition-colors " +
              (tab === k ? "border-black text-black" : "border-transparent text-gray-300 hover:text-gray-500")}>
            {label}
          </button>
        ))}
      </div>
      {tab === "routine" ? <RoutineSetup tenantId={tenant.id} /> : <ScheduleCalendar tenantId={tenant.id} />}
    </>
  );
}

export default function RoutinesPage() {
  return (
    <main className={styles.main}>
      <Suspense fallback={<div className="text-xs text-gray-400">…</div>}>
        <RoutinesInner />
      </Suspense>
    </main>
  );
}
