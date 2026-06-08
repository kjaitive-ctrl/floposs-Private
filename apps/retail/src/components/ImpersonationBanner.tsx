"use client";

import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";

// A/S 임퍼소네이션 상시 배너 — localStorage 마커(flo-impersonating) 있을 때만 렌더.
// 일반 사용자는 마커가 없어 완전 no-op. "관리자로 돌아가기" = retail signOut + 마커 삭제.
export default function ImpersonationBanner() {
  const [label, setLabel] = useState<string | null>(null);

  useEffect(() => {
    try { setLabel(localStorage.getItem("flo-impersonating")); } catch {}
  }, []);

  if (!label) return null;

  async function exit() {
    try { localStorage.removeItem("flo-impersonating"); } catch {}
    await supabase.auth.signOut();
    window.location.href = "/login";
  }

  return (
    <div className="sticky top-0 z-[60] bg-red-600 text-white text-xs px-4 py-2 flex items-center justify-between gap-3">
      <span>
        ⚠ 관리자 A/S — <b>{label === "1" ? "이 매장" : label}</b> 계정으로 보는 중. 변경은 매장 명의로 저장됩니다.
      </span>
      <button onClick={exit} className="underline font-medium whitespace-nowrap">관리자로 돌아가기</button>
    </div>
  );
}
