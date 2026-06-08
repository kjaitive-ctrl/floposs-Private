"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase";

// 진입점 — 세션 있으면 /pickups, 없으면 /login.
export default function Home() {
  const router = useRouter();
  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      router.replace(session ? "/pickups" : "/login");
    });
  }, [router]);
  return <div className="min-h-screen flex items-center justify-center text-sm text-gray-400">불러오는 중...</div>;
}
