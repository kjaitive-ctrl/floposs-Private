"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase";
import { bizReset } from "@/lib/bizSession";

export default function AccountSuspendedPage() {
  const router = useRouter();
  const [companyName, setCompanyName] = useState<string>("");
  const [contactEmail, setContactEmail] = useState<string>("");

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

      // 문의 이메일 (platform_settings)
      const { data: settings } = await supabase
        .from("platform_settings")
        .select("contact_email")
        .eq("id", 1)
        .maybeSingle();
      if (settings?.contact_email) setContactEmail(settings.contact_email);
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
          <div className="w-14 h-14 mx-auto rounded-full bg-red-50 flex items-center justify-center mb-4">
            <span className="text-2xl">⚠</span>
          </div>
          <h1 className="text-xl font-bold text-gray-900 mb-2">계정 정지</h1>
          {companyName && (
            <p className="text-sm text-gray-600 mb-1">
              <span className="font-medium">{companyName}</span>
            </p>
          )}
          <p className="text-sm text-gray-500 leading-relaxed">
            현재 계정이 정지된 상태입니다.<br />
            자세한 사유는 관리자에게 문의해주세요.
          </p>
          {contactEmail && (
            <p className="mt-4 text-sm text-gray-700">
              문의: <a href={`mailto:${contactEmail}`} className="text-primary hover:underline">{contactEmail}</a>
            </p>
          )}

          <button onClick={handleLogout}
            className="mt-8 text-sm text-gray-500 hover:text-gray-700">
            로그아웃
          </button>
        </div>
      </div>
    </div>
  );
}
