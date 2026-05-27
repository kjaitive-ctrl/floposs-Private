"use client";

import { useEffect, useState } from "react";
import { supabase } from "./supabase";

// platform_settings (싱글톤 id=1) 의 사업자/브랜드 정보.
// admin/general-settings 에서 super_admin 이 관리. anon read 허용 (RLS 비활성).
// 같은 supabase 인스턴스 (wholesale 과 공유) → 한 곳 변경 시 wholesale + retail 모두 반영.
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

export function usePlatformSettings() {
  const [settings, setSettings] = useState<PlatformSettings | null>(null);

  useEffect(() => {
    let cancelled = false;
    supabase
      .from("platform_settings")
      .select("service_name, service_brand_letter, company_name, representative_name, business_number, ecommerce_license, address, contact_email")
      .eq("id", 1)
      .maybeSingle()
      .then(({ data }) => {
        if (!cancelled && data) setSettings(data as PlatformSettings);
      });
    return () => { cancelled = true; };
  }, []);

  return settings;
}
