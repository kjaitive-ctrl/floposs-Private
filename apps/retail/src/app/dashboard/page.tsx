"use client";

import { useTenant } from "@/lib/TenantContext";
import ProjectSchedule from "@/components/routines/ProjectSchedule";
import LongTermTasksPanel from "@/components/routines/LongTermTasksPanel";

// 대시보드 = 일정 (FLO 로고 → 이리로). 사장 결정 2026-11-05.
// 일정 = 주 블록 × 프로젝트 행(ProjectSchedule, 마이그 234).
// 우측 패널 = 프로젝트 바 + 장기과제(날짜 미정 할일, 마이그 232). xl 이상 화면에서만 노출.
export default function DashboardHome() {
  const { tenant } = useTenant();
  return (
    <main className="max-w-[1800px] mx-auto px-6 pt-3 pb-8">
      {!tenant?.id ? (
        <div className="text-xs text-gray-400">불러오는 중…</div>
      ) : (
        <ProjectSchedule tenantId={tenant.id} side={<LongTermTasksPanel tenantId={tenant.id} />} />
      )}
    </main>
  );
}
