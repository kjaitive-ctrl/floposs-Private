"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase";
import { bizReset } from "@/lib/bizSession";

export default function AccountPendingPage() {
  const router = useRouter();
  const [companyName, setCompanyName] = useState<string>("");

  useEffect(() => {
    (async () => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) {
        router.push("/login");
        return;
      }
      const tenantId = (user.app_metadata as { tenant_id?: string })?.tenant_id;
      if (tenantId) {
        const { data } = await supabase
          .from("tenants")
          .select("company_name, status")
          .eq("id", tenantId)
          .maybeSingle();
        // 이미 active 면 dashboard 로
        if (data?.status === "active") {
          router.push("/dashboard");
          return;
        }
        if (data?.company_name) setCompanyName(data.company_name);
      }
    })();
  }, [router]);

  async function handleLogout() {
    bizReset();
    await supabase.auth.signOut();
    router.push("/login");
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-gray-50 to-gray-100 px-4 py-10">
      <div className="w-full max-w-md text-center">
        <div className="bg-white rounded-2xl shadow-lg border border-gray-100 p-10">
          <div className="w-14 h-14 mx-auto rounded-full bg-primary-soft flex items-center justify-center mb-4">
            <span className="text-2xl">⏳</span>
          </div>
          <h1 className="text-xl font-bold text-gray-900 mb-2">가입 승인 대기 중</h1>
          {companyName && (
            <p className="text-sm text-gray-600 mb-1">
              <span className="font-medium">{companyName}</span>
            </p>
          )}
          <p className="text-sm text-gray-500 leading-relaxed">
            가입 신청이 접수되었습니다.<br />
            관리자 검토 후 서비스 이용이 가능합니다.<br />
            승인 결과는 등록하신 이메일로 안내드립니다.
          </p>

          <button onClick={handleLogout}
            className="mt-8 text-sm text-gray-500 hover:text-gray-700">
            로그아웃
          </button>
        </div>
      </div>
    </div>
  );
}
