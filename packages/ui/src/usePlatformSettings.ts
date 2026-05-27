"use client";

import { useEffect, useState } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";

// platform_settings (싱글톤 id=1) 의 사업자/브랜드 정보.
// admin/general-settings 에서 super_admin 이 관리. anon read 허용 (RLS 비활성).
// 양쪽 app (wholesale/retail) 모두 같은 supabase 인스턴스 → 같은 데이터.
// supabase client 는 각 app 의 singleton 을 인자로 받음 (cookie 분리 보존 — sb-wholesale-auth vs sb-retail-auth).
export interface PlatformSettings {
  service_name: string | null;
  service_brand_letter: string | null;
  company_name: string | null;
  representative_name: string | null;
  business_number: string | null;
  ecommerce_license: string | null;
  address: string | null;
  contact_email: string | null;
}

export function usePlatformSettings(supabase: SupabaseClient) {
  const [settings, setSettings] = useState<PlatformSettings | null>(null);

  useEffect(() => {
    let cancelled = false;
    supabase
      .from("platform_settings")
      .select("service_name, service_brand_letter, company_name, representative_name, business_number, ecommerce_license, address, contact_email")
      .eq("id", 1)
      .maybeSingle()
      .then(({ data }: { data: PlatformSettings | null }) => {
        if (!cancelled && data) setSettings(data);
      });
    return () => { cancelled = true; };
  }, [supabase]);

  return settings;
}
