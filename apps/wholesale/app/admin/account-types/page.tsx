"use client";

import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import Modal from "@/app/dashboard/_components/Modal";

type AccountType = {
  id: string;
  code: string;
  label: string;
  description: string | null;
  dashboard_route: string;
  is_signup_enabled: boolean;
  display_order: number;
  created_at: string;
  updated_at: string;
};

type FormState = {
  code: string;
  label: string;
  description: string;
  dashboard_route: string;
  is_signup_enabled: boolean;
  display_order: number;
};

const emptyForm: FormState = {
  code: "",
  label: "",
  description: "",
  dashboard_route: "",
  is_signup_enabled: true,
  display_order: 0,
};

export default function AccountTypesPage() {
  const [items, setItems] = useState<AccountType[]>([]);
  const [loading, setLoading] = useState(true);
  const [showModal, setShowModal] = useState(false);
  const [editing, setEditing] = useState<AccountType | null>(null);
  const [form, setForm] = useState<FormState>(emptyForm);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => { fetchItems(); }, []);

  async function fetchItems() {
    setLoading(true);
    const { data } = await supabase
      .from("account_types")
      .select("*")
      .order("display_order")
      .order("created_at");
    if (data) setItems(data as AccountType[]);
    setLoading(false);
  }

  function openAdd() {
    setEditing(null);
    setForm({ ...emptyForm, display_order: items.length + 1 });
    setError("");
    setShowModal(true);
  }

  function openEdit(t: AccountType) {
    setEditing(t);
    setForm({
      code: t.code,
      label: t.label,
      description: t.description ?? "",
      dashboard_route: t.dashboard_route,
      is_signup_enabled: t.is_signup_enabled,
      display_order: t.display_order,
    });
    setError("");
    setShowModal(true);
  }

  async function handleSave() {
    if (!form.code.trim()) return setError("code 를 입력해주세요.");
    if (!form.label.trim()) return setError("라벨을 입력해주세요.");
    if (!form.dashboard_route.trim()) return setError("dashboard_route 를 입력해주세요.");
    setSaving(true);
    setError("");

    const payload = {
      code: form.code.trim(),
      label: form.label.trim(),
      description: form.description.trim() || null,
      dashboard_route: form.dashboard_route.trim(),
      is_signup_enabled: form.is_signup_enabled,
      display_order: Number(form.display_order),
    };

    const { error: dbError } = editing
      ? await supabase.from("account_types").update(payload).eq("id", editing.id)
      : await supabase.from("account_types").insert(payload);

    setSaving(false);
    if (dbError) {
      setError(
        dbError.code === "23505"
          ? "이미 존재하는 code 입니다."
          : dbError.message
      );
      return;
    }
    setShowModal(false);
    fetchItems();
  }

  async function toggleSignup(t: AccountType) {
    await supabase.from("account_types")
      .update({ is_signup_enabled: !t.is_signup_enabled })
      .eq("id", t.id);
    setItems(prev => prev.map(x =>
      x.id === t.id ? { ...x, is_signup_enabled: !t.is_signup_enabled } : x
    ));
  }

  async function handleDelete(t: AccountType) {
    const userCheck = await supabase
      .from("users")
      .select("id", { count: "exact", head: true })
      .eq("user_type", t.code);

    const count = userCheck.count ?? 0;
    const warn = count > 0
      ? `\n\n⚠ 이 업종 (${t.code}) 으로 등록된 사용자가 ${count}명 있습니다. 삭제 시 해당 사용자의 로그인 라우팅이 끊어질 수 있습니다.`
      : "";

    if (!confirm(`"${t.label}" 업종을 삭제하시겠습니까?${warn}\n\n삭제 후 되돌릴 수 없습니다.`)) return;

    const { error: dbError } = await supabase.from("account_types").delete().eq("id", t.id);
    if (dbError) return alert(dbError.message);
    setItems(prev => prev.filter(x => x.id !== t.id));
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className="text-2xl font-bold text-gray-900">업종 관리</h2>
          <p className="text-sm text-gray-500 mt-0.5">
            가입 페이지에 표시될 업종(도매/소매/음식점 등) 옵션을 관리합니다.
          </p>
        </div>
        <button onClick={openAdd}
          className="px-4 py-2 bg-primary text-white text-sm rounded-lg hover:bg-primary-hover">
          + 업종 추가
        </button>
      </div>

      <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 mb-5 text-xs text-amber-800">
        ⚠ 신규 업종 추가는 <strong>가입 폼/API/대시보드 라우트</strong>가 코드에 함께 구현되어 있어야 동작합니다.
        이 페이지는 <strong>이미 코드로 추가된 업종을 노출/숨김 토글</strong>하는 용도입니다.
      </div>

      {loading ? (
        <p className="text-gray-400 text-sm">불러오는 중...</p>
      ) : items.length === 0 ? (
        <div className="text-center py-16 text-gray-300 bg-white rounded-xl border border-gray-100">
          등록된 업종이 없습니다.
        </div>
      ) : (
        <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b border-gray-200">
              <tr className="text-left text-xs text-gray-500 uppercase tracking-wide">
                <th className="px-4 py-3 w-16">순서</th>
                <th className="px-4 py-3">code / 라벨</th>
                <th className="px-4 py-3">설명</th>
                <th className="px-4 py-3 w-44">dashboard_route</th>
                <th className="px-4 py-3 w-28 text-center">가입 노출</th>
                <th className="px-4 py-3 w-44 text-right">관리</th>
              </tr>
            </thead>
            <tbody>
              {items.map(t => (
                <tr key={t.id} className="border-b border-gray-100 last:border-b-0 hover:bg-gray-50">
                  <td className="px-4 py-3 text-gray-500">{t.display_order}</td>
                  <td className="px-4 py-3">
                    <div className="font-mono text-xs text-gray-500">{t.code}</div>
                    <div className="font-medium text-gray-900">{t.label}</div>
                  </td>
                  <td className="px-4 py-3 text-gray-600 text-xs">{t.description ?? "—"}</td>
                  <td className="px-4 py-3 font-mono text-xs text-gray-700">{t.dashboard_route}</td>
                  <td className="px-4 py-3 text-center">
                    <button onClick={() => toggleSignup(t)}
                      className={`px-2.5 py-1 text-xs rounded-full font-medium ${
                        t.is_signup_enabled
                          ? "bg-green-100 text-green-700 hover:bg-green-200"
                          : "bg-gray-100 text-gray-500 hover:bg-gray-200"
                      }`}>
                      {t.is_signup_enabled ? "노출" : "숨김"}
                    </button>
                  </td>
                  <td className="px-4 py-3 text-right">
                    <button onClick={() => openEdit(t)}
                      className="px-3 py-1 border border-gray-300 text-gray-600 rounded-lg text-xs hover:bg-gray-50 mr-1">
                      수정
                    </button>
                    <button onClick={() => handleDelete(t)}
                      className="px-3 py-1 border border-red-200 text-red-500 rounded-lg text-xs hover:bg-red-50">
                      삭제
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {showModal && (
        <Modal onClose={() => !saving && setShowModal(false)} size="md">
          <div className="p-5 border-b border-gray-100">
            <h3 className="text-lg font-bold text-gray-900">
              {editing ? "업종 수정" : "업종 추가"}
            </h3>
          </div>
          <div className="p-5 space-y-3">
            <Field label="code (영문 식별자)" required>
              <input type="text" value={form.code}
                onChange={e => setForm(f => ({ ...f, code: e.target.value }))}
                disabled={!!editing}
                placeholder="wholesale, retail, restaurant ..."
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm font-mono focus:outline-none focus:ring-2 focus:ring-primary-ring disabled:bg-gray-50 disabled:text-gray-500" />
              {editing && (
                <p className="text-xs text-gray-400 mt-1">
                  code 는 users.user_type 과 매칭되는 키라 수정 불가합니다.
                </p>
              )}
            </Field>
            <Field label="라벨 (가입 폼 표시명)" required>
              <input type="text" value={form.label}
                onChange={e => setForm(f => ({ ...f, label: e.target.value }))}
                placeholder="도매업체, 소매업체, 음식점 ..."
                className="w-full input-md" />
            </Field>
            <Field label="설명 (가입 폼 보조 문구)">
              <input type="text" value={form.description}
                onChange={e => setForm(f => ({ ...f, description: e.target.value }))}
                placeholder="예: 의류 도매업 운영자 — 거래처/재고/주문/정산 관리"
                className="w-full input-md" />
            </Field>
            <Field label="dashboard_route" required>
              <input type="text" value={form.dashboard_route}
                onChange={e => setForm(f => ({ ...f, dashboard_route: e.target.value }))}
                placeholder="/dashboard, __retail__ ..."
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm font-mono focus:outline-none focus:ring-2 focus:ring-primary-ring" />
              <p className="text-xs text-gray-400 mt-1">
                내부 경로 (예: <code>/dashboard</code>) 또는 sentinel (<code>__retail__</code> = retail-site URL).
              </p>
            </Field>

            <div className="grid grid-cols-2 gap-3">
              <Field label="정렬 순서">
                <input type="number" value={form.display_order}
                  onChange={e => setForm(f => ({ ...f, display_order: Number(e.target.value) }))}
                  className="w-full input-md" />
              </Field>
              <div className="flex items-center gap-2 mt-6">
                <input type="checkbox" id="is_signup_enabled"
                  checked={form.is_signup_enabled}
                  onChange={e => setForm(f => ({ ...f, is_signup_enabled: e.target.checked }))}
                  className="rounded" />
                <label htmlFor="is_signup_enabled" className="text-sm text-gray-700">
                  가입 폼 노출
                </label>
              </div>
            </div>

            {error && (
              <div className="p-2.5 bg-red-50 border border-red-200 rounded-lg text-sm text-red-600">
                {error}
              </div>
            )}
          </div>
          <div className="flex gap-2 p-5 border-t border-gray-100">
            <button onClick={() => setShowModal(false)} disabled={saving}
              className="flex-1 py-2.5 border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50 text-sm">
              취소
            </button>
            <button onClick={handleSave} disabled={saving}
              className="flex-1 py-2.5 bg-primary text-white rounded-lg hover:bg-primary-hover disabled:opacity-50 font-medium text-sm">
              {saving ? "저장 중..." : editing ? "수정 완료" : "업종 추가"}
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}

function Field({ label, required, children }: {
  label: string;
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label className="block text-xs text-gray-600 mb-1">
        {label}{required && <span className="text-red-500 ml-0.5">*</span>}
      </label>
      {children}
    </div>
  );
}
