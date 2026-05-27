"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import { styles } from "@/common/styles";
import type { TenantFull } from "@/lib/types";

// 마이그 189: 구독 만료 안내 페이지.
// TenantContext 가드가 만료 시 본 페이지로 redirect.
// 표시: 만료일 + 안내 + (베타 기간 종료 시) 결제 안내 placeholder.

type TenantBrief = Pick<TenantFull, "company_name" | "subscription_expires_at" | "subscription_plans">;

export default function SubscriptionRequiredPage() {
  const [tenant, setTenant] = useState<TenantBrief | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) {
        setLoading(false);
        return;
      }
      const tenantId = (user.app_metadata as { tenant_id?: string } | undefined)?.tenant_id;
      if (!tenantId) {
        setLoading(false);
        return;
      }
      const { data } = await supabase
        .from("tenants")
        .select("company_name, subscription_expires_at, subscription_plans(name, price)")
        .eq("id", tenantId)
        .single();
      setTenant(data as unknown as TenantBrief);
      setLoading(false);
    })();
  }, []);

  async function handleLogout() {
    await fetch("/api/order-portal/logout", { method: "POST" });
    window.location.href = "/login";
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-white px-4">
      <div className="max-w-md w-full bg-white rounded-2xl shadow-lg border border-gray-100 p-8">
        <div className="text-center mb-6">
          <div className="inline-flex w-12 h-12 rounded-xl bg-amber-500 text-white items-center justify-center text-2xl mb-3">
            ⚠
          </div>
          <h1 className="text-xl font-bold text-gray-900">구독이 만료되었습니다</h1>
          {tenant?.company_name && (
            <p className="text-sm text-gray-500 mt-1">{tenant.company_name}</p>
          )}
        </div>

        {loading ? (
          <p className="text-xs text-gray-400 text-center py-4">불러오는 중…</p>
        ) : (
          <>
            <div className="bg-gray-50 border border-gray-200 rounded-lg p-4 mb-4 text-sm space-y-2">
              {tenant?.subscription_plans && (
                <div className="flex justify-between">
                  <span className="text-gray-500">최근 플랜</span>
                  <span className="text-black font-medium">{tenant.subscription_plans.name}</span>
                </div>
              )}
              {tenant?.subscription_expires_at && (
                <div className="flex justify-between">
                  <span className="text-gray-500">만료일</span>
                  <span className="text-black font-medium">
                    {new Date(tenant.subscription_expires_at).toLocaleDateString("ko-KR")}
                  </span>
                </div>
              )}
            </div>

            <div className={`${styles.msgWarn} mb-4 leading-relaxed`}>
              계속 이용하시려면 구독 연장이 필요합니다.<br />
              결제 안내는 별도로 전달드릴 예정입니다.
            </div>

            <div className="space-y-2">
              <Link href="/dashboard/settings"
                className={`${styles.btnPrimary} block w-full text-center py-2.5`}>
                내정보 / 결제수단 확인
              </Link>
              <button onClick={handleLogout}
                className={`${styles.btnSecondary} block w-full py-2.5`}>
                로그아웃
              </button>
            </div>

            <p className="text-[11px] text-gray-400 text-center mt-4">
              문의: kjaitive@gmail.com
            </p>
          </>
        )}
      </div>
    </div>
  );
}
