"use client";

import { useEffect, useState, useCallback } from "react";
import { useRouter, usePathname } from "next/navigation";
import { supabase } from "@/lib/supabase";

// admin app 의 sidebar layout. URL 단순화 (/admin/X → /X) — admin 도메인 자체가 admin.
// wholesale 전용 로직 (bizReset) 제거 — admin 은 영업 세션 무관.
type BadgeKey = "pendingAccounts" | "pendingRetailAccounts" | "openInquiries";

type MenuItem = { label: string; path: string; badgeKey?: BadgeKey };
type MenuGroup = { label: string; items: MenuItem[] };

// retail 위주 재편 (2026-05-28): 업종별 구분선 그룹핑. 업종관리는 메뉴에서 제외
// (route/code 는 존치 — 5축 확장 대비). [[project_multi_vertical_saas]]
const menuGroups: MenuGroup[] = [
  { label: "retail", items: [
    { label: "소매계정관리",     path: "/accounts-retail", badgeKey: "pendingRetailAccounts" },
    { label: "소매 구독플랜",    path: "/plans-retail" },
    { label: "이미지 용량",      path: "/r2-usage" },
    { label: "측정 카테고리",    path: "/measurement-templates" },
    { label: "TEST2",           path: "/test2" },
  ] },
  { label: "wholesale", items: [
    { label: "계정관리",         path: "/accounts",        badgeKey: "pendingAccounts" },
  ] },
  { label: "logi", items: [
    { label: "삼촌계정관리",      path: "/accounts-logi" },
  ] },
  { label: "admin", items: [
    { label: "매장관리",         path: "/stores" },
    { label: "구독플랜 (전체)",  path: "/plans" },
    { label: "문의처리",         path: "/inquiries",            badgeKey: "openInquiries" },
    { label: "일반설정",         path: "/general-settings" },
    { label: "약관관리",         path: "/legal" },
    { label: "TEST",            path: "/test" },
  ] },
];

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const [checking, setChecking] = useState(true);
  const [counts, setCounts] = useState<Record<BadgeKey, number>>({
    pendingAccounts: 0,
    pendingRetailAccounts: 0,
    openInquiries: 0,
  });

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      const role = (session?.user?.app_metadata as { role?: string } | undefined)?.role;
      if (!session || role !== "super_admin") {
        router.push("/login");
      } else {
        setChecking(false);
      }
    });
  }, [router]);

  // 미처리 카운트 — 페이지 이동 시 자동 갱신 (사용자가 그 페이지 들어가서 처리하고 나오면 fresh)
  const fetchCounts = useCallback(async () => {
    const [{ count: pending }, { count: pendingRetail }, { count: open }] = await Promise.all([
      supabase.from("tenants").select("*", { count: "exact", head: true }).eq("status", "pending"),
      supabase.from("tenants").select("*", { count: "exact", head: true }).eq("status", "pending").eq("tenant_type", "retail"),
      supabase.from("inquiries").select("*", { count: "exact", head: true }).eq("status", "open"),
    ]);
    setCounts({
      pendingAccounts: pending ?? 0,
      pendingRetailAccounts: pendingRetail ?? 0,
      openInquiries: open ?? 0,
    });
  }, []);

  useEffect(() => {
    if (checking) return;
    fetchCounts();
  }, [checking, fetchCounts, pathname]);

  async function handleLogout() {
    await supabase.auth.signOut();
    router.push("/login");
  }

  if (checking) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <p className="text-gray-500 text-sm">확인 중...</p>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex">
      <aside className="w-56 bg-gray-900 text-white flex flex-col fixed h-full">
        <div className="p-5 border-b border-gray-700">
          <h1 className="text-base font-bold text-white">Admin Console</h1>
          <p className="text-xs text-gray-400 mt-0.5">플로포스 통합 관리자</p>
        </div>
        <nav className="flex-1 p-3 space-y-1 overflow-y-auto">
          {menuGroups.map(g => (
            <div key={g.label} className="pt-2 first:pt-0">
              {/* 업종 구분선 + 라벨 */}
              <div className="flex items-center gap-2 px-2 pb-1.5">
                <span className="text-[10px] font-semibold uppercase tracking-wider text-gray-500">{g.label}</span>
                <div className="flex-1 h-px bg-gray-700" />
              </div>
              {g.items.map(m => {
                // 정확 일치 또는 하위 경로만 활성 — "/accounts" 가 "/accounts-retail" 을 잡지 않도록.
                const isActive = pathname === m.path || pathname.startsWith(m.path + "/");
                const badgeCount = m.badgeKey ? counts[m.badgeKey] : 0;
                // 그 메뉴에 들어가 있으면 badge 숨김 ("그 메뉴 들어가면 사라지게")
                const showBadge = badgeCount > 0 && !isActive;
                return (
                  <button key={m.path} onClick={() => router.push(m.path)}
                    className={`w-full flex items-center justify-between px-3 py-2 rounded-lg text-sm transition-colors ${
                      isActive
                        ? "bg-primary text-white"
                        : "text-gray-300 hover:bg-gray-700 hover:text-white"
                    }`}>
                    <span>{m.label}</span>
                    {showBadge && (
                      <span className="inline-flex items-center justify-center min-w-[20px] h-5 px-1.5 bg-red-500 text-white text-[11px] font-bold rounded-full">
                        {badgeCount > 99 ? "99+" : badgeCount}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          ))}
        </nav>
        <div className="p-3 border-t border-gray-700">
          <button onClick={handleLogout}
            className="w-full px-3 py-2 text-sm text-gray-400 hover:text-white hover:bg-gray-700 rounded-lg transition-colors text-left">
            로그아웃
          </button>
        </div>
      </aside>

      <main className="flex-1 ml-56 p-8 bg-gray-50 min-h-screen">
        {children}
      </main>
    </div>
  );
}
