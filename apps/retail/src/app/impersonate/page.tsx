"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase";

// A/S 진입 — admin 이 발급한 magiclink token_hash 로 verifyOtp → 그 매장 세션(sb-retail-auth).
// 비번 미변경. 성공 시 임퍼 마커(localStorage) 세팅 → 배너 노출 → /dashboard.
export default function ImpersonatePage() {
  const router = useRouter();
  const [msg, setMsg] = useState("매장 계정으로 진입 중…");

  useEffect(() => {
    const sp = new URLSearchParams(window.location.search);
    const tokenHash = sp.get("token_hash");
    const label = sp.get("label") ?? "";
    if (!tokenHash) { setMsg("진입 토큰이 없습니다."); return; }
    (async () => {
      const { error } = await supabase.auth.verifyOtp({ type: "magiclink", token_hash: tokenHash });
      if (error) { setMsg("진입 실패: " + error.message); return; }
      try { localStorage.setItem("flo-impersonating", label || "1"); } catch {}
      router.replace("/dashboard");
    })();
  }, [router]);

  return <div className="min-h-screen flex items-center justify-center text-sm text-gray-500">{msg}</div>;
}
