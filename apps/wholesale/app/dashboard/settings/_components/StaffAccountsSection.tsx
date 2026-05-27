"use client";

import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";

const DEFAULT_GUIDE = [
  "매장 PC 에 매장 계정으로 항상 로그인되어 있게 두세요.",
  "사장님은 본인 디바이스(폰/노트북)에서 본인 계정으로 로그인해서 매출/정산을 봅니다.",
  "직원이 퇴사하면 [비활성화] 버튼으로 즉시 로그인을 차단할 수 있습니다.",
  "역할 = 직원/매니저. 현재 가시성은 동일 (사장 정책상 추후 메뉴별 차등 가능).",
];

type StaffUser = {
  id: string;
  email: string;
  name: string;
  role: "staff" | "manager";
  memo: string | null;
  is_active: boolean;
  created_at: string;
  last_login_at: string | null;
  created_by: string | null;
  created_by_name: string | null;
};

function formatDateTime(iso: string): string {
  const d = new Date(iso);
  const yy = String(d.getFullYear()).slice(2);
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const mi = String(d.getMinutes()).padStart(2, "0");
  return `${yy}-${mm}-${dd} ${hh}:${mi}`;
}

type PendingRow = {
  email: string;
  password: string;
  name: string;
  role: "staff" | "manager";
  memo: string;
};

type EditDraft = {
  password: string;  // 빈값이면 변경 X
  name: string;
  role: "staff" | "manager";
  memo: string;
};

const emptyRow = (): PendingRow => ({ email: "", password: "", name: "", role: "staff", memo: "" });

const ROLE_LABEL: Record<string, string> = { staff: "직원", manager: "매니저" };

export default function StaffAccountsSection() {
  const [users, setUsers] = useState<StaffUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState<PendingRow | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState<EditDraft | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [guideItems, setGuideItems] = useState<string[]>(DEFAULT_GUIDE);

  async function load() {
    setLoading(true);
    const res = await fetch("/api/auth/staff-signup");
    const json = await res.json();
    if (res.ok) setUsers(json.users ?? []);
    setLoading(false);
  }

  useEffect(() => { load(); }, []);

  // 가이드 멘트 — admin (super_admin) 이 /admin/test 에서 편집한 platform_settings.dashboard_texts 가져오기
  useEffect(() => {
    (async () => {
      const { data } = await supabase
        .from("platform_settings")
        .select("dashboard_texts")
        .eq("id", 1)
        .maybeSingle();
      const items = (data?.dashboard_texts as { staff_guide_items?: string[] } | null)?.staff_guide_items;
      if (items && Array.isArray(items) && items.length > 0) setGuideItems(items);
    })();
  }, []);

  async function handleSubmit() {
    if (!pending) return;
    if (!pending.email || !pending.password || !pending.name) {
      setError("이메일/비밀번호/이름은 필수입니다.");
      return;
    }
    if (pending.password.length < 6) {
      setError("비밀번호는 6자 이상.");
      return;
    }
    setSubmitting(true);
    setError("");

    const res = await fetch("/api/auth/staff-signup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(pending),
    });
    const json = await res.json();
    setSubmitting(false);
    if (!res.ok) { setError(json.error ?? "추가 실패"); return; }

    setPending(null);
    load();
  }

  function startEdit(u: StaffUser) {
    setPending(null);
    setError("");
    setEditingId(u.id);
    setEditDraft({
      password: "",
      name: u.name,
      role: u.role,
      memo: u.memo ?? "",
    });
  }

  function cancelEdit() {
    setEditingId(null);
    setEditDraft(null);
    setError("");
  }

  async function handleEditSave() {
    if (!editingId || !editDraft) return;
    if (!editDraft.name) { setError("이름은 필수입니다."); return; }
    if (editDraft.password && editDraft.password.length < 6) {
      setError("비밀번호는 6자 이상."); return;
    }
    setSubmitting(true);
    setError("");
    const body: Record<string, unknown> = {
      user_id: editingId,
      name: editDraft.name,
      role: editDraft.role,
      memo: editDraft.memo,
    };
    if (editDraft.password) body.password = editDraft.password;
    const res = await fetch("/api/auth/staff-signup", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = await res.json();
    setSubmitting(false);
    if (!res.ok) { setError(json.error ?? "수정 실패"); return; }
    cancelEdit();
    load();
  }

  async function handleDeactivate(user_id: string, email: string) {
    if (!confirm(`${email} 계정을 비활성화하시겠습니까?\n비활성화 후엔 로그인이 차단됩니다. (이력은 그대로 보존)`)) return;
    const res = await fetch("/api/auth/staff-signup", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ user_id }),
    });
    const json = await res.json();
    if (!res.ok) { alert(json.error ?? "비활성화 실패"); return; }
    load();
  }

  return (
    <div className="space-y-4">
      <section className="bg-white rounded-xl border border-gray-200 p-5">
        <div className="mb-4">
          <h2 className="text-sm font-semibold text-gray-700">매장 계정</h2>
          <p className="text-xs text-gray-400 mt-0.5">매장 PC / 직원이 로그인할 계정 관리</p>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-sm border-collapse">
            <thead>
              <tr className="border-b border-gray-200 bg-gray-50">
                <th className="text-left text-xs font-medium text-gray-500 px-3 py-2 w-[22%]">이메일</th>
                <th className="text-left text-xs font-medium text-gray-500 px-3 py-2 w-[12%]">비밀번호</th>
                <th className="text-left text-xs font-medium text-gray-500 px-3 py-2 w-[12%]">이름</th>
                <th className="text-left text-xs font-medium text-gray-500 px-3 py-2 w-[8%]">역할</th>
                <th className="text-left text-xs font-medium text-gray-500 px-3 py-2 w-[16%]">메모</th>
                <th className="text-left text-xs font-medium text-gray-500 px-3 py-2 w-[18%]">등록일시</th>
                <th className="text-right text-xs font-medium text-gray-500 px-3 py-2 w-[12%]">액션</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td colSpan={7} className="text-xs text-gray-400 py-6 text-center">불러오는 중...</td></tr>
              ) : users.length === 0 && !pending ? (
                <tr><td colSpan={7} className="text-xs text-gray-400 py-6 text-center">아직 매장 계정이 없습니다. 아래 [+ 추가] 로 등록하세요.</td></tr>
              ) : (
                users.map(u => {
                  const isEditing = editingId === u.id && editDraft;
                  if (isEditing && editDraft) {
                    return (
                      <tr key={u.id} className="border-b border-gray-100 bg-amber-50/40">
                        <td className="px-3 py-2 text-xs text-gray-500" title="이메일은 수정 불가">{u.email}</td>
                        <td className="px-2 py-1.5">
                          <input
                            type="text" value={editDraft.password}
                            onChange={e => setEditDraft({ ...editDraft, password: e.target.value })}
                            placeholder="변경 시만 입력"
                            className="w-full input-md text-xs"
                          />
                        </td>
                        <td className="px-2 py-1.5">
                          <input
                            type="text" value={editDraft.name}
                            onChange={e => setEditDraft({ ...editDraft, name: e.target.value })}
                            className="w-full input-md text-xs"
                          />
                        </td>
                        <td className="px-2 py-1.5">
                          <select
                            value={editDraft.role}
                            onChange={e => setEditDraft({ ...editDraft, role: e.target.value as "staff" | "manager" })}
                            className="w-full input-md text-xs"
                          >
                            <option value="staff">직원</option>
                            <option value="manager">매니저</option>
                          </select>
                        </td>
                        <td className="px-2 py-1.5">
                          <input
                            type="text" value={editDraft.memo}
                            onChange={e => setEditDraft({ ...editDraft, memo: e.target.value })}
                            placeholder="메모 (선택)"
                            className="w-full input-md text-xs"
                          />
                        </td>
                        <td className="px-3 py-2 text-xs text-gray-500">
                          <div>{formatDateTime(u.created_at)}</div>
                          {u.created_by_name && (
                            <div className="text-[10px] text-gray-400">by {u.created_by_name}</div>
                          )}
                        </td>
                        <td className="px-2 py-1.5 text-right whitespace-nowrap">
                          <button
                            onClick={handleEditSave}
                            disabled={submitting}
                            className="text-[11px] px-3 py-1 bg-primary text-white rounded hover:bg-primary-hover disabled:opacity-50 transition-colors mr-1"
                          >{submitting ? "..." : "저장"}</button>
                          <button
                            onClick={cancelEdit}
                            className="text-[11px] px-2 py-1 border border-gray-200 text-gray-500 rounded hover:bg-gray-50 transition-colors"
                          >취소</button>
                        </td>
                      </tr>
                    );
                  }
                  return (
                    <tr key={u.id} className={`border-b border-gray-100 ${u.is_active ? "" : "opacity-50"}`}>
                      <td className="px-3 py-2 text-xs text-gray-700">{u.email}</td>
                      <td className="px-3 py-2 text-xs text-gray-300">••••••</td>
                      <td className="px-3 py-2 text-xs text-gray-800 font-medium">
                        {u.name}
                        {!u.is_active && <span className="ml-1 text-[10px] px-1 py-0.5 bg-red-50 text-red-500 rounded">비활성</span>}
                      </td>
                      <td className="px-3 py-2 text-xs text-gray-700">{ROLE_LABEL[u.role] ?? u.role}</td>
                      <td className="px-3 py-2 text-xs text-gray-500 truncate" title={u.memo ?? ""}>{u.memo ?? "—"}</td>
                      <td className="px-3 py-2 text-xs text-gray-500">
                        <div>{formatDateTime(u.created_at)}</div>
                        {u.created_by_name && (
                          <div className="text-[10px] text-gray-400">by {u.created_by_name}</div>
                        )}
                      </td>
                      <td className="px-3 py-2 text-right whitespace-nowrap">
                        {u.is_active && (
                          <>
                            <button
                              onClick={() => startEdit(u)}
                              disabled={!!editingId || !!pending}
                              className="text-[11px] px-2 py-1 border border-gray-300 text-gray-600 rounded hover:bg-gray-50 disabled:opacity-40 transition-colors mr-1"
                            >수정</button>
                            <button
                              onClick={() => handleDeactivate(u.id, u.email)}
                              disabled={!!editingId || !!pending}
                              className="text-[11px] px-2 py-1 border border-red-200 text-red-500 rounded hover:bg-red-50 disabled:opacity-40 transition-colors"
                            >비활성화</button>
                          </>
                        )}
                      </td>
                    </tr>
                  );
                })
              )}

              {/* pending 행 — 입력 중 */}
              {pending && (
                <tr className="border-b border-gray-100 bg-primary-soft/30">
                  <td className="px-2 py-1.5">
                    <input
                      type="email" value={pending.email}
                      onChange={e => setPending({ ...pending, email: e.target.value })}
                      placeholder="store@..."
                      className="w-full input-md text-xs"
                    />
                  </td>
                  <td className="px-2 py-1.5">
                    <input
                      type="text" value={pending.password}
                      onChange={e => setPending({ ...pending, password: e.target.value })}
                      placeholder="6자 이상"
                      className="w-full input-md text-xs"
                    />
                  </td>
                  <td className="px-2 py-1.5">
                    <input
                      type="text" value={pending.name}
                      onChange={e => setPending({ ...pending, name: e.target.value })}
                      placeholder="이름"
                      className="w-full input-md text-xs"
                    />
                  </td>
                  <td className="px-2 py-1.5">
                    <select
                      value={pending.role}
                      onChange={e => setPending({ ...pending, role: e.target.value as "staff" | "manager" })}
                      className="w-full input-md text-xs"
                    >
                      <option value="staff">직원</option>
                      <option value="manager">매니저</option>
                    </select>
                  </td>
                  <td className="px-2 py-1.5">
                    <input
                      type="text" value={pending.memo}
                      onChange={e => setPending({ ...pending, memo: e.target.value })}
                      placeholder="메모 (선택)"
                      className="w-full input-md text-xs"
                    />
                  </td>
                  <td className="px-2 py-1.5 text-xs text-gray-300">— (등록 시 자동)</td>
                  <td className="px-2 py-1.5 text-right whitespace-nowrap">
                    <button
                      onClick={handleSubmit}
                      disabled={submitting}
                      className="text-[11px] px-3 py-1 bg-primary text-white rounded hover:bg-primary-hover disabled:opacity-50 transition-colors mr-1"
                    >{submitting ? "..." : "등록"}</button>
                    <button
                      onClick={() => { setPending(null); setError(""); }}
                      className="text-[11px] px-2 py-1 border border-gray-200 text-gray-500 rounded hover:bg-gray-50 transition-colors"
                    >취소</button>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        {error && (
          <p className="text-xs text-red-500 mt-2">{error}</p>
        )}

        {/* + 추가 버튼 (pending/수정 모드 아닐 때만) */}
        {!pending && !editingId && !loading && (
          <button
            onClick={() => { setPending(emptyRow()); setError(""); }}
            className="mt-3 w-full py-2 border border-dashed border-gray-300 rounded-lg text-xs text-gray-500 hover:bg-gray-50 hover:text-gray-700 transition-colors"
          >+ 매장 계정 추가</button>
        )}
      </section>

      <section className="bg-primary-soft rounded-xl border border-primary-soft-hover p-4 text-xs text-primary-hover">
        <p className="font-semibold mb-1">매장 계정 운영 가이드</p>
        <ul className="list-disc list-inside space-y-0.5 text-primary">
          {guideItems.map((item, i) => <li key={i}>{item}</li>)}
        </ul>
      </section>
    </div>
  );
}
