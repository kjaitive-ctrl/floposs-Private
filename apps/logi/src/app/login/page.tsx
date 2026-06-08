"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase";

// logi 로그인 — admin 이 발급한 이메일+비밀번호 (자가가입 X). [[project_logi_axis]]
export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPw, setShowPw] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setPending(true);
    const { data, error } = await supabase.auth.signInWithPassword({ email: email.trim().toLowerCase(), password });
    setPending(false);
    if (error) { setError("이메일 또는 비밀번호가 올바르지 않습니다."); return; }
    const userType = (data.user?.app_metadata as { user_type?: string } | undefined)?.user_type;
    if (userType !== "logistics") {
      await supabase.auth.signOut();
      setError("물류(logi) 계정이 아닙니다.");
      return;
    }
    router.push("/pickups");
  }

  return (
    <div className="min-h-screen flex items-center justify-center p-4">
      <div className="w-full max-w-sm bg-white rounded-2xl shadow-lg border border-gray-100 p-8">
        <div className="text-center mb-6">
          <div className="inline-flex w-12 h-12 rounded-xl bg-primary text-white items-center justify-center text-lg font-bold mb-2">물류</div>
          <h1 className="text-2xl font-bold text-gray-900">픽업 관리</h1>
          <p className="text-sm text-gray-500 mt-1">플로포스 물류 · 사입삼촌</p>
        </div>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">이메일</label>
            <input type="email" required autoFocus value={email} onChange={e => setEmail(e.target.value)}
              autoComplete="username"
              className="w-full px-4 py-2.5 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary-ring" />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">비밀번호</label>
            <input type={showPw ? "text" : "password"} required value={password} onChange={e => setPassword(e.target.value)}
              autoComplete="current-password"
              className="w-full px-4 py-2.5 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary-ring" />
            <label className="flex items-center gap-1.5 text-xs text-gray-500 mt-1.5">
              <input type="checkbox" checked={showPw} onChange={e => setShowPw(e.target.checked)} className="rounded" />
              비밀번호 표시
            </label>
          </div>
          {error && <p className="text-sm text-red-600">⚠ {error}</p>}
          <button type="submit" disabled={pending}
            className="w-full py-2.5 bg-primary text-white text-sm font-medium rounded-lg hover:bg-primary-hover disabled:opacity-50">
            {pending ? "로그인 중..." : "로그인"}
          </button>
        </form>
      </div>
    </div>
  );
}
