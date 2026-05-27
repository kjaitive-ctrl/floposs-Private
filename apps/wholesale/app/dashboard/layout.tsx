"use client";

import { useEffect, useState } from "react";
import { useRouter, usePathname } from "next/navigation";
import { supabase } from "@/lib/supabase";
import { getTenantInfo } from "@/lib/tenant";
import { bizOpen, bizClose, bizReset, bizSyncFromRow } from "@/lib/bizSession";
import { useAccount } from "@/lib/useAccount";
import { canAccessMenu } from "@/lib/menuVisibility";
import { isSubscriptionActive } from "@/lib/subscription";
import BizSessionOpenModal from "./_components/BizSessionOpenModal";
import BusinessSettleModal from "./_components/BusinessSettleModal";

const menus = [
  { label: "POS",          key: "orders-test",      path: "/dashboard/orders-test" },
  { label: "상품 관리",    key: "products",          path: "/dashboard/products" },
  { label: "거래처 관리",   key: "customers",         path: "/dashboard/customers" },
  { label: "재고 관리",    key: "inventory",         path: "/dashboard/inventory" },
  { label: "입출금 관리",   key: "transactions",      path: "/dashboard/transactions" },
  { label: "영업정산",     key: "sales-settlement",  path: "/dashboard/sales-settlement" },
  { label: "부가세 정산",   key: "vat-settlement",    path: "/dashboard/vat-settlement" },
  { label: "매출리포트",    key: "sales-report",      path: "/dashboard/sales-report", disabled: true },
  { label: "문의",         key: "inquiries",         path: "/dashboard/inquiries" },
  { label: "구독 및 설정",  key: "settings",          path: "/dashboard/settings" },
];

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const { account, role, isAdmin } = useAccount();
  const [checking, setChecking] = useState(true);

  const [bizStatus, setBizStatus] = useState<"before" | "active">("before");
  const [bizStart, setBizStart] = useState<Date | null>(null);
  const [lastSettlement, setLastSettlement] = useState<Date | null>(null);
  const [elapsed, setElapsed] = useState("");
  const [companyName, setCompanyName] = useState("도매 POS");
  const [tenantId, setTenantId] = useState("");
  const [showOpenModal, setShowOpenModal] = useState(false);
  const [showSettleModal, setShowSettleModal] = useState(false);

  function syncFromStorage() {
    const status = localStorage.getItem("biz_status");
    const start = localStorage.getItem("biz_start");
    const settlement = localStorage.getItem("biz_settlement");
    if (status === "active" && start) {
      setBizStatus("active");
      setBizStart(new Date(start));
    } else {
      setBizStatus("before");
      setBizStart(null);
    }
    if (settlement) setLastSettlement(new Date(settlement));
  }

  useEffect(() => {
    syncFromStorage();
    window.addEventListener("bizStatusChange", syncFromStorage);
    return () => window.removeEventListener("bizStatusChange", syncFromStorage);
  }, []);

  useEffect(() => {
    if (bizStatus !== "active" || !bizStart) { setElapsed(""); return; }
    const tick = () => {
      const diff = Date.now() - bizStart.getTime();
      const h = Math.floor(diff / 3600000);
      const m = Math.floor((diff % 3600000) / 60000);
      const s = Math.floor((diff % 60000) / 1000);
      setElapsed(`${h}시간 ${m}분 ${s}초`);
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [bizStatus, bizStart]);

  useEffect(() => {
    (async () => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) { router.push("/login"); return; }

      const meta = (user.app_metadata ?? {}) as { role?: string; tenant_id?: string };

      // tenant 회원 (사장/직원) — status + 구독 게이트. super_admin 은 bypass.
      if (meta.role !== "super_admin" && meta.tenant_id) {
        const { data: tenant } = await supabase
          .from("tenants")
          .select("status, plan_id, subscription_expires_at")
          .eq("id", meta.tenant_id)
          .maybeSingle();

        if (tenant?.status === "pending") { router.push("/account-pending"); return; }
        if (tenant?.status === "suspended") { router.push("/account-suspended"); return; }
        if (!isSubscriptionActive(tenant?.plan_id, tenant?.subscription_expires_at)) {
          router.push("/subscription-required");
          return;
        }
      }

      setChecking(false);
      const info = await getTenantInfo();
      if (info) { setCompanyName(info.companyName); setTenantId(info.id); }

      // 현재 tenant 의 활성 세션을 DB 에서 조회해 localStorage 와 동기화.
      // 이전 사용자/다른 tenant 의 잔재 캐시를 덮어쓴다.
      const tid = meta.tenant_id ?? info?.id;
      if (tid) {
        const { data: openSession } = await supabase
          .from("biz_sessions")
          .select("id, opened_at")
          .eq("tenant_id", tid)
          .eq("status", "open")
          .maybeSingle();
        bizSyncFromRow(openSession ?? null);
      } else {
        bizReset();
      }
    })();
  }, [router]);

  async function handleLogout() {
    bizReset();
    await supabase.auth.signOut();
    router.push("/login");
  }

  if (checking) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <p className="text-gray-500">불러오는 중...</p>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex">
      <aside className="w-40 bg-gray-900 text-white flex flex-col fixed h-full">
        <div className="border-b border-gray-700">
          <button
            onClick={() => router.push("/dashboard/orders-test")}
            className="w-full px-4 pt-3 pb-1 flex items-center hover:bg-gray-800 transition-colors"
          >
            <h1 className="text-sm font-bold truncate">{companyName}</h1>
          </button>
          <div className="px-4 pb-2">
            {bizStatus === "active" ? (
              <span className="inline-flex items-center gap-1 px-2 py-0.5 bg-emerald-700 text-emerald-100 rounded-full text-xs font-bold">
                <span className="w-1.5 h-1.5 bg-emerald-300 rounded-full animate-pulse inline-block" />
                영업 중
              </span>
            ) : (
              <span className="inline-flex items-center gap-1 px-2 py-0.5 bg-gray-700 text-gray-400 rounded-full text-xs font-semibold">
                <span className="w-1.5 h-1.5 bg-gray-500 rounded-full inline-block" />
                영업 전
              </span>
            )}
          </div>
          {bizStatus === "active" ? (
            <div className="px-4 pb-2">
              <p className="text-xs text-gray-400">{elapsed}</p>
              <p className="text-xs text-gray-500">
                {bizStart?.toLocaleString("ko-KR", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })} 개시
              </p>
            </div>
          ) : lastSettlement ? (
            <div className="px-4 pb-2">
              <p className="text-xs text-gray-500">
                정산 {lastSettlement.toLocaleString("ko-KR", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}
              </p>
            </div>
          ) : null}
          <div className="flex flex-col gap-1.5 px-4 pb-3">
            <button
              onClick={() => setShowOpenModal(true)}
              disabled={bizStatus === "active"}
              className="w-full py-1.5 text-xs font-bold rounded-lg transition-colors disabled:opacity-30 disabled:cursor-not-allowed bg-primary hover:bg-primary-ring text-white"
            >
              영업개시
            </button>
            <button
              onClick={() => setShowSettleModal(true)}
              disabled={bizStatus === "before"}
              className="w-full py-1.5 text-xs font-bold rounded-lg transition-colors disabled:opacity-30 disabled:cursor-not-allowed bg-orange-500 hover:bg-orange-400 text-white"
            >
              영업정산
            </button>
          </div>
        </div>
        <nav className="flex-1 p-4 space-y-1 overflow-y-auto">
          {menus
            // role 미설정 (백필 안 된 단일 사장 계정) 에는 전체 노출
            .filter(menu => !role || canAccessMenu(role, menu.key))
            .map(menu => (
              <button
                key={menu.key}
                onClick={() => { if (!menu.disabled) router.push(menu.path); }}
                disabled={menu.disabled}
                className={`w-full text-left px-3 py-2 rounded-lg text-sm transition-colors ${
                  menu.disabled
                    ? "text-gray-500 cursor-not-allowed"
                    : pathname === menu.path
                    ? "bg-primary text-white"
                    : "text-gray-300 hover:bg-gray-700 hover:text-white"
                }`}
              >
                {menu.label}
              </button>
            ))}
        </nav>
        <div className="p-4 border-t border-gray-700 space-y-2">
          {account && (
            <div className="px-2 text-xs text-gray-400 truncate" title={account.email}>
              <span
                className={`inline-block px-1.5 py-0.5 rounded text-[10px] font-bold mr-1.5 ${
                  isAdmin ? "bg-primary-hover text-primary-border" : "bg-gray-700 text-gray-300"
                }`}
              >
                {isAdmin ? "사장" : role === "staff" ? "매장" : role ?? "—"}
              </span>
              <span className="text-gray-500">{account.email}</span>
            </div>
          )}
          <button
            onClick={handleLogout}
            className="w-full px-3 py-2 text-sm text-gray-400 hover:text-white hover:bg-gray-700 rounded-lg transition-colors text-left"
          >
            로그아웃
          </button>
        </div>
      </aside>

      <main className="flex-1 ml-40 p-8">
        {children}
      </main>

      {showOpenModal && tenantId && (
        <BizSessionOpenModal
          tenantId={tenantId}
          onClose={() => setShowOpenModal(false)}
          onSuccess={bizSessionId => { setShowOpenModal(false); bizOpen(bizSessionId); }}
        />
      )}

      {showSettleModal && tenantId && (
        <BusinessSettleModal
          onClose={() => setShowSettleModal(false)}
          onSuccess={() => { setShowSettleModal(false); bizClose(); }}
        />
      )}
    </div>
  );
}
