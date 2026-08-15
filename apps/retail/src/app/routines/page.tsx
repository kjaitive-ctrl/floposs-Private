"use client";

import { Suspense, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useTenant } from "@/lib/TenantContext";
import RoutineSetup from "@/components/routines/RoutineSetup";
import ScheduleCalendar from "@/components/routines/ScheduleCalendar";
import LongTermTasksPanel from "@/components/routines/LongTermTasksPanel";

// 업무루틴 + 일정 세팅(메인). 기본 탭=일정. ?tab=routine 으로 업무루틴 탭 직행. 마이그 208.
// 좌측 여백 = 장기과제(날짜 미정 할일) 패널. xl 이상 화면에서만 노출(마이그 232).
function RoutinesInner() {
  const { tenant } = useTenant();
  const sp = useSearchParams();
  const [tab, setTab] = useState<"routine" | "schedule">(sp.get("tab") === "routine" ? "routine" : "schedule");

  if (!tenant?.id) return <div className="text-xs text-gray-400">불러오는 중…</div>;

  const tabs: [typeof tab, string][] = [["routine", "업무루틴"], ["schedule", "일정"]];

  return (
    <div className="flex gap-4 items-start">
      <aside className="hidden xl:block w-[32rem] shrink-0 sticky top-16">
        <LongTermTasksPanel tenantId={tenant.id} />
      </aside>
      <div className="flex-1 min-w-0 max-w-6xl mx-auto">
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
      </div>
    </div>
  );
}

export default function RoutinesPage() {
  return (
    <main className="max-w-[1800px] mx-auto px-6 py-8">
      <Suspense fallback={<div className="text-xs text-gray-400">…</div>}>
        <RoutinesInner />
      </Suspense>
    </main>
  );
}
