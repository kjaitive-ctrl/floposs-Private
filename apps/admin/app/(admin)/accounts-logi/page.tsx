"use client";

import { useEffect, useState, useCallback } from "react";
import { supabase } from "@/lib/supabase";

// 삼촌계정관리 — 물류회사(tenant_type='logistics') 계정 발급/조회. [[project_logi_axis]]
// logi 는 자가가입 X → super_admin 이 여기서 직접 발급. 이메일+비밀번호 로그인(logi 앱).

type LogiUser = { id: string; email: string; last_login_at: string | null };
type LogiTenant = {
  id: string;
  company_name: string;
  phone: string | null;
  created_at: string;
  is_active: boolean;
  users: LogiUser[];
};

function isValidPassword(pw: string): boolean {
  return pw.length >= 8 && /[A-Za-z]/.test(pw) && /\d/.test(pw) && /[^A-Za-z0-9]/.test(pw);
}

const emptyForm = { company_name: "", email: "", password: "", phone: "" };

export default function LogiAccountsPage() {
  const [tenants, setTenants] = useState<LogiTenant[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState(emptyForm);
  const [showPw, setShowPw] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const fetchAll = useCallback(async () => {
    setLoading(true);
    const { data } = await supabase
      .from("tenants")
      .select("id, company_name, phone, created_at, is_active, users(id, email, last_login_at)")
      .eq("tenant_type", "logistics")
      .order("created_at", { ascending: false });
    setTenants((data as unknown as LogiTenant[]) ?? []);
    setLoading(false);
  }, []);

  useEffect(() => { fetchAll(); }, [fetchAll]);

  async function handleCreate() {
    if (!form.company_name.trim()) return setError("물류회사명을 입력해주세요.");
    if (!form.email.trim())        return setError("이메일을 입력해주세요.");
    if (!isValidPassword(form.password))
      return setError("비밀번호는 영문·숫자·특수문자를 포함해 8자 이상이어야 합니다.");
    setSaving(true);
    setError("");
    const { data: { session } } = await supabase.auth.getSession();
    const res = await fetch("/api/admin/create-logi", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${session?.access_token}` },
      body: JSON.stringify(form),
    });
    const result = await res.json();
    setSaving(false);
    if (!res.ok) { setError(result.error || "계정 생성 실패"); return; }
    setForm(emptyForm);
    setShowForm(false);
    fetchAll();
  }

  async function handleReset(email: string) {
    const np = prompt(`${email} 의 새 비밀번호 (영문+숫자+특수문자 8자 이상)`);
    if (!np) return;
    if (!isValidPassword(np)) { alert("비밀번호 정책 미충족 (영문+숫자+특수문자 8자 이상)"); return; }
    const { data: { session } } = await supabase.auth.getSession();
    const res = await fetch("/api/admin/reset-password", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${session?.access_token}` },
      body: JSON.stringify({ email, new_password: np }),
    });
    const r = await res.json();
    alert(res.ok ? "변경되었습니다. 새 비밀번호를 회사에 전달해주세요." : (r.error || "변경 실패"));
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-xl font-bold text-gray-900">삼촌계정관리</h1>
          <p className="text-sm text-gray-500 mt-0.5">물류회사 계정 {tenants.length}개 · 픽업 요청 수신</p>
        </div>
        <button onClick={() => { setShowForm(v => !v); setError(""); }}
          className="px-4 py-2 bg-primary text-white text-sm rounded-lg hover:bg-primary-hover">
          {showForm ? "닫기" : "+ 물류회사 등록"}
        </button>
      </div>

      {showForm && (
        <div className="mb-6 p-4 bg-white border border-gray-200 rounded-xl space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs text-gray-600 mb-1">물류회사명 *</label>
              <input value={form.company_name} onChange={e => setForm(f => ({ ...f, company_name: e.target.value }))}
                className="w-full input-md" placeholder="OO물류 / 삼촌이름" />
            </div>
            <div>
              <label className="block text-xs text-gray-600 mb-1">전화</label>
              <input value={form.phone} onChange={e => setForm(f => ({ ...f, phone: e.target.value }))}
                className="w-full input-md" placeholder="010-..." />
            </div>
            <div>
              <label className="block text-xs text-gray-600 mb-1">로그인 이메일 *</label>
              <input type="email" value={form.email} onChange={e => setForm(f => ({ ...f, email: e.target.value }))}
                className="w-full input-md" placeholder="logi@example.com" />
            </div>
            <div>
              <label className="block text-xs text-gray-600 mb-1">비밀번호 * (영문+숫자+특수문자 8자↑)</label>
              <input type={showPw ? "text" : "password"} value={form.password}
                onChange={e => setForm(f => ({ ...f, password: e.target.value }))}
                className="w-full input-md" />
              <label className="flex items-center gap-1.5 text-xs text-gray-500 mt-1">
                <input type="checkbox" checked={showPw} onChange={e => setShowPw(e.target.checked)} className="rounded" />
                비밀번호 표시
              </label>
            </div>
          </div>
          {error && <p className="text-xs text-red-500">{error}</p>}
          <button onClick={handleCreate} disabled={saving}
            className="px-4 py-2 bg-primary text-white text-sm rounded-lg hover:bg-primary-hover disabled:opacity-50">
            {saving ? "생성 중..." : "계정 생성"}
          </button>
        </div>
      )}

      <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 border-b border-gray-200">
            <tr>
              <th className="text-left px-4 py-3 text-gray-600 font-medium">물류회사</th>
              <th className="text-left px-4 py-3 text-gray-600 font-medium">로그인 이메일</th>
              <th className="text-left px-4 py-3 text-gray-600 font-medium">전화</th>
              <th className="text-left px-4 py-3 text-gray-600 font-medium">최근 로그인</th>
              <th className="px-4 py-3" />
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={5} className="px-4 py-8 text-center text-gray-400">불러오는 중...</td></tr>
            ) : tenants.length === 0 ? (
              <tr><td colSpan={5} className="px-4 py-8 text-center text-gray-400">등록된 물류회사가 없습니다.</td></tr>
            ) : tenants.map(t => {
              const u = t.users[0];
              return (
                <tr key={t.id} className="border-b border-gray-100 last:border-0">
                  <td className="px-4 py-3 font-medium text-gray-900">{t.company_name}</td>
                  <td className="px-4 py-3 text-gray-600">{u?.email ?? "-"}</td>
                  <td className="px-4 py-3 text-gray-600">{t.phone ?? "-"}</td>
                  <td className="px-4 py-3 text-gray-500">
                    {u?.last_login_at ? new Date(u.last_login_at).toLocaleString("ko-KR") : "기록 없음"}
                  </td>
                  <td className="px-4 py-3 text-right">
                    {u?.email && (
                      <button onClick={() => handleReset(u.email)}
                        className="text-xs px-3 py-1.5 border border-gray-300 rounded-lg text-gray-600 hover:bg-gray-50">
                        비밀번호 재설정
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
