"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase";
import { usePlatformSettings, BusinessInfoFooter } from "@floposs/ui";

// admin 전용 로그인. super_admin role 만 허용 (그 외 즉시 signOut + 안내).
// 이미 로그인 + super_admin 이면 / 로 redirect.
export default function AdminLoginPage() {
  const router = useRouter();
  const settings = usePlatformSettings(supabase);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [authChecking, setAuthChecking] = useState(true);

  useEffect(() => {
    let cancelled = false;
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (cancelled) return;
      const role = (session?.user?.app_metadata as { role?: string } | undefined)?.role;
      if (session && role === "super_admin") {
        router.push("/");
        return;
      }
      setAuthChecking(false);
    });
    return () => { cancelled = true; };
  }, [router]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError("");
    const { data, error: authError } = await supabase.auth.signInWithPassword({ email, password });
    if (authError || !data.user) {
      setError("이메일 또는 비밀번호가 올바르지 않습니다.");
      setLoading(false);
      return;
    }
    const role = (data.user.app_metadata as { role?: string } | undefined)?.role;
    if (role !== "super_admin") {
      // super_admin 아닌 계정은 admin 사이트 접근 불가 — 즉시 signOut.
      await supabase.auth.signOut();
      setError("관리자 권한이 없습니다.");
      setLoading(false);
      return;
    }
    router.push("/");
  }

  if (authChecking) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-gray-50 to-gray-100">
        <p className="text-sm text-gray-400">불러오는 중...</p>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-gray-50 to-gray-100 px-4 py-10">
      <div className="w-full max-w-md">
        <div className="bg-white rounded-2xl shadow-lg border border-gray-100 p-8">
          <div className="text-center mb-6">
            <div className="inline-flex w-12 h-12 rounded-xl bg-primary text-white items-center justify-center text-lg font-bold mb-2">
              {settings?.service_brand_letter ?? "F"}
            </div>
            <h1 className="text-2xl font-bold text-gray-900">관리자 로그인</h1>
            <p className="text-sm text-gray-500 mt-1">super_admin 전용 — 플로포스 통합 관리</p>
          </div>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">이메일</label>
              <input type="email" value={email} onChange={e => setEmail(e.target.value)} required autoFocus
                autoComplete="email"
                className="w-full px-4 py-2.5 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary-ring" />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">비밀번호</label>
              <input type="password" value={password} onChange={e => setPassword(e.target.value)} required
                autoComplete="current-password"
                className="w-full px-4 py-2.5 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary-ring" />
              {error && (
                <div className="flex items-start gap-1.5 text-sm text-red-600 mt-1.5">
                  <span className="leading-none mt-0.5">⚠</span>
                  <span>{error}</span>
                </div>
              )}
            </div>
            <button type="submit" disabled={loading}
              className="w-full py-2.5 bg-primary text-white rounded-lg text-sm font-medium hover:bg-primary-hover disabled:opacity-60">
              {loading ? "로그인 중..." : "로그인"}
            </button>
          </form>
        </div>
        {/* 공간 미리 예약 — settings 비동기 로드돼도 높이 안 변해 카드 떨림 방지 */}
        <div className="min-h-[140px]">
          <BusinessInfoFooter settings={settings} />
        </div>
      </div>
    </div>
  );
}
