"use client";

import type { PlatformSettings } from "./usePlatformSettings";

// 사업자 정보 푸터. /login + 무인증 페이지에서 사용.
// hardcode 금지 — source 는 platform_settings (admin/general-settings 단일 관리).
// 호출 측이 usePlatformSettings(supabase) 로 fetch 후 settings 전달 (supabase client 분리 보존).
// settings 가 fetch 되기 전엔 렌더 안 함 (fallback hardcode X).
export function BusinessInfoFooter({ settings }: { settings: PlatformSettings | null }) {
  if (!settings) return null;

  const headLine = [
    settings.company_name,
    settings.representative_name && `대표 ${settings.representative_name}`,
    settings.business_number && `사업자등록번호 ${settings.business_number}`,
  ].filter(Boolean).join(" · ");

  return (
    <>
      <p className="text-center text-xs text-gray-400 mt-4">
        © {new Date().getFullYear()} {settings.service_name ?? ""} · 멀티 업종 통합 플랫폼
      </p>
      <div className="text-center text-[11px] text-gray-400 mt-3 leading-relaxed space-y-0.5">
        {headLine && <p>{headLine}</p>}
        {settings.ecommerce_license && <p>통신판매업신고번호 {settings.ecommerce_license}</p>}
        {settings.address && <p>{settings.address}</p>}
        {settings.contact_email && <p className="mt-1">contact : {settings.contact_email}</p>}
      </div>
    </>
  );
}
