"use client";

import { styles } from "@/common/styles";
import { useTenant } from "@/lib/TenantContext";
import { WeatherWidget, TodayTasksWidget, UpcomingScheduleWidget } from "@/components/dashboard/DashboardWidgets";

// Retail 위젯형 대시보드 홈 (FLO 로고 → 이리로). 좌=오늘할일/일정, 우끝=날씨.
export default function DashboardHome() {
  const { tenant } = useTenant();
  return (
    <main className={styles.main}>
      <div className="flex gap-4 items-start">
        <div className="flex-1 space-y-4 min-w-0">
          {tenant?.id ? (
            <>
              <TodayTasksWidget tenantId={tenant.id} />
              <UpcomingScheduleWidget tenantId={tenant.id} />
            </>
          ) : (
            <div className="text-xs text-gray-400">불러오는 중…</div>
          )}
        </div>
        <div className="w-72 shrink-0">
          <WeatherWidget />
        </div>
      </div>
    </main>
  );
}
