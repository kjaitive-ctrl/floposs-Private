"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { supabase } from "@/lib/supabase";
import type { TenantBase } from "@/lib/types";

type MeTenant = Pick<TenantBase, "id" | "company_name" | "default_payment_method">;

const PAYMENT_LABEL: Record<string, string> = {
  cash: "현금",
  transfer: "계좌이체",
  credit: "외상(청구)",
};

export default function OrderHeader() {
  const router = useRouter();
  const [tenant, setTenant] = useState<MeTenant | null>(null);

  // 브라우저 → Supabase Seoul 직통 (vercel 경유 X — retail-site 속도 절대 원칙).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data: { user } } = await supabase.auth.getUser();
      if (cancelled || !user) return;
      const tenantId = (user.app_metadata as { tenant_id?: string } | undefined)?.tenant_id;
      if (!tenantId) return;
      const { data } = await supabase
        .from("tenants")
        .select("id, company_name, default_payment_method")
        .eq("id", tenantId)
        .single();
      if (!cancelled && data) setTenant(data as MeTenant);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function handleLogout() {
    await fetch("/api/order-portal/logout", { method: "POST" });
    router.push("/order");
    router.refresh();
  }

  return (
    <header className="bg-white border-b border-gray-200 px-6 py-3 flex items-center gap-4">
      {/* 리테일 본진으로 돌아가기 — 포털이 retail 탭으로 들어와 별도모듈 느낌이라 추가(C1) */}
      <Link href="/samples" className="text-xs text-gray-500 hover:text-black whitespace-nowrap">
        ← 리테일
      </Link>
      <Link href="/order/browse" className="text-sm font-bold text-black">
        주문 포털
      </Link>
      <div className="ml-auto flex items-center gap-3 text-xs">
        {tenant ? (
          <>
            <span className="text-black font-medium">{tenant.company_name}</span>
            {tenant.default_payment_method && (
              <span className="px-2 py-0.5 bg-gray-100 text-gray-700 rounded">
                {PAYMENT_LABEL[tenant.default_payment_method] ?? tenant.default_payment_method}
              </span>
            )}
          </>
        ) : (
          <span className="text-gray-400">…</span>
        )}
        <Link href="/order/me" className="text-gray-500 hover:text-black underline">
          내 정보
        </Link>
        <button
          type="button"
          onClick={handleLogout}
          className="text-gray-500 hover:text-black underline"
        >
          로그아웃
        </button>
      </div>
    </header>
  );
}
