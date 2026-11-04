"use client";

import { useTenant } from "@/lib/TenantContext";
import ProjectSchedule from "@/components/routines/ProjectSchedule";
import LongTermTasksPanel from "@/components/routines/LongTermTasksPanel";

// 일정 = 주 블록 × 프로젝트 행(ProjectSchedule, 마이그 234).
// 우측 여백 = 장기과제(날짜 미정 할일) 패널. xl 이상 화면에서만 노출(마이그 232).
export default function RoutinesPage() {
  const { tenant } = useTenant();
  return (
    <main className="max-w-[1800px] mx-auto px-6 pt-3 pb-8">
      {!tenant?.id ? (
        <div className="text-xs text-gray-400">불러오는 중…</div>
      ) : (
        <div className="flex gap-4 items-start">
          <div className="flex-1 min-w-0 max-w-6xl mx-auto">
            <ProjectSchedule tenantId={tenant.id} />
          </div>
          <aside className="hidden xl:block w-[32rem] shrink-0 sticky top-16">
            <LongTermTasksPanel tenantId={tenant.id} />
          </aside>
        </div>
      )}
    </main>
  );
}
