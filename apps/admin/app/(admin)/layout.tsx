"use client";

import { useEffect, useState, useCallback } from "react";
import { useRouter, usePathname } from "next/navigation";
import { supabase } from "@/lib/supabase";

// admin app 의 sidebar layout. URL 단순화 (/admin/X → /X) — admin 도메인 자체가 admin.
// wholesale 전용 로직 (bizReset) 제거 — admin 은 영업 세션 무관.
type BadgeKey = "pendingAccounts" | "openInquiries";

type MenuItem = { label: string; path: string; badgeKey?: BadgeKey };

const menus: MenuItem[] = [
  { label: "계정관리", path: "/accounts",         badgeKey: "pendingAccounts" },
  { label: "문의처리", path: "/inquiries",        badgeKey: "openInquiries" },
  { label: "구독플랜", path: "/plans" },
  { label: "업종관리", path: "/account-types" },
  { label: "일반설정", path: "/general-settings" },
  { label: "약관관리", path: "/legal" },
  { label: "TEST",    path: "/test" },
];

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const [checking, setChecking] = useState(true);
  const [counts, setCounts] = useState<Record<BadgeKey, number>>({
    pendingAccounts: 0,
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
    const [{ count: pending }, { count: open }] = await Promise.all([
      supabase.from("tenants").select("*", { count: "exact", head: true }).eq("status", "pending"),
      supabase.from("inquiries").select("*", { count: "exact", head: true }).eq("status", "open"),
    ]);
    setCounts({
      pendingAccounts: pending ?? 0,
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
        <nav className="flex-1 p-3 space-y-1">
          {menus.map(m => {
            const isActive = pathname.startsWith(m.path);
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
