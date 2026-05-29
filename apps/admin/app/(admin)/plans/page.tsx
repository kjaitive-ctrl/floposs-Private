"use client";

import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import { krw } from "@/lib/format";
import { Modal } from "@floposs/ui";

type Vertical = "wholesale" | "retail" | "logistics" | "designer" | "platform" | "restaurant" | "other";

type Plan = {
  id: string;
  name: string;
  description: string | null;
  price: number;
  billing_cycle: string;
  features: string[];
  is_active: boolean;
  sort_order: number;
  vertical: Vertical;
  r2_storage_quota_mb: number;  // 마이그 200 — 0 = 무제한
  created_at: string;
};

const BILLING_LABEL: Record<string, string> = {
  monthly: "월간",
  yearly: "연간",
  one_time: "일회성",
};

// 마이그 189: vertical 별 플랜 풀 분리. 탭은 wholesale/retail 만 (5축 추가 시 확장).
// retail 위주 재편 (2026-05-28): 소매를 맨 앞 + 기본 탭으로.
const VERTICAL_TABS: { key: Vertical; label: string }[] = [
  { key: "retail",    label: "소매 (Retail)" },
  { key: "wholesale", label: "도매 (Wholesale)" },
];

const emptyForm = {
  name: "",
  description: "",
  price: 0,
  billing_cycle: "monthly",
  features: "",
  is_active: true,
  sort_order: 0,
  vertical: "retail" as Vertical,
  r2_storage_quota_mb: 500,  // Free Beta 기본
};

function formatQuota(mb: number): string {
  if (mb === 0) return "무제한";
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`;
  return `${mb} MB`;
}

// fixedVertical 이 지정되면 그 vertical 만 표시하고 vertical 탭/입력 숨김.
// /plans = 전체 (탭 표시) / /plans-retail = retail 고정.
export default function PlansPage({ fixedVertical }: { fixedVertical?: Vertical } = {}) {
  const [plans, setPlans] = useState<Plan[]>([]);
  const [loading, setLoading] = useState(true);
  const [showModal, setShowModal] = useState(false);
  const [editing, setEditing] = useState<Plan | null>(null);
  const [form, setForm] = useState({ ...emptyForm, vertical: fixedVertical ?? "retail" as Vertical });
  const [saving, setSaving] = useState(false);
  const [verticalTab, setVerticalTab] = useState<Vertical>(fixedVertical ?? "retail");

  useEffect(() => { fetchPlans(); }, []);

  const filteredPlans = plans.filter(p => p.vertical === verticalTab);

  async function fetchPlans() {
    setLoading(true);
    const { data } = await supabase.from("subscription_plans")
      .select("*").order("sort_order").order("created_at");
    if (data) setPlans(data as Plan[]);
    setLoading(false);
  }

  function openAdd() {
    setEditing(null);
    // 신규 플랜은 현재 탭/고정의 vertical 로 자동 설정
    setForm({ ...emptyForm, sort_order: filteredPlans.length + 1, vertical: fixedVertical ?? verticalTab });
    setShowModal(true);
  }

  function openEdit(p: Plan) {
    setEditing(p);
    setForm({
      name: p.name,
      description: p.description || "",
      price: p.price,
      billing_cycle: p.billing_cycle,
      features: p.features.join("\n"),
      is_active: p.is_active,
      sort_order: p.sort_order,
      vertical: p.vertical,
      r2_storage_quota_mb: p.r2_storage_quota_mb ?? 500,
    });
    setShowModal(true);
  }

  async function handleSave() {
    if (!form.name.trim()) return alert("플랜명을 입력해주세요.");
    setSaving(true);
    const features = form.features.split("\n").map(s => s.trim()).filter(Boolean);
    const payload = {
      name: form.name,
      description: form.description || null,
      price: Number(form.price),
      billing_cycle: form.billing_cycle,
      features,
      is_active: form.is_active,
      sort_order: Number(form.sort_order),
      vertical: form.vertical,
      r2_storage_quota_mb: Math.max(0, Number(form.r2_storage_quota_mb) || 0),
    };
    if (editing) {
      await supabase.from("subscription_plans").update(payload).eq("id", editing.id);
    } else {
      await supabase.from("subscription_plans").insert(payload);
    }
    setSaving(false);
    setShowModal(false);
    fetchPlans();
  }

  async function toggleActive(p: Plan) {
    await supabase.from("subscription_plans").update({ is_active: !p.is_active }).eq("id", p.id);
    setPlans(prev => prev.map(x => x.id === p.id ? { ...x, is_active: !p.is_active } : x));
  }

  async function deletePlan(p: Plan) {
    if (!confirm(`"${p.name}" 플랜을 삭제하시겠습니까?`)) return;
    await supabase.from("subscription_plans").delete().eq("id", p.id);
    setPlans(prev => prev.filter(x => x.id !== p.id));
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <div>
          <h2 className="text-2xl font-bold text-gray-900">
            {fixedVertical === "retail" ? "소매 구독플랜"
              : fixedVertical === "wholesale" ? "도매 구독플랜"
              : "구독 플랜"}
          </h2>
          <p className="text-sm text-gray-500 mt-0.5">
            {fixedVertical
              ? `${fixedVertical} 이용자에게 제공할 플랜을 관리합니다`
              : "이용자에게 제공할 플랜을 vertical 별로 관리합니다"}
          </p>
        </div>
        <button onClick={openAdd}
          className="px-4 py-2 bg-primary text-white text-sm rounded-lg hover:bg-primary-hover">
          + 플랜 추가
        </button>
      </div>

      {/* vertical 탭 — fixedVertical 시 숨김 */}
      {!fixedVertical && (
        <div className="flex gap-1 mb-6 border-b border-gray-200">
          {VERTICAL_TABS.map(tab => {
            const count = plans.filter(p => p.vertical === tab.key).length;
            const active = verticalTab === tab.key;
            return (
              <button key={tab.key}
                onClick={() => setVerticalTab(tab.key)}
                className={`px-4 py-2 text-sm border-b-2 transition-colors ${
                  active ? "border-primary text-primary font-medium" : "border-transparent text-gray-500 hover:text-gray-700"
                }`}>
                {tab.label} <span className="text-xs text-gray-400 ml-1">({count})</span>
              </button>
            );
          })}
        </div>
      )}

      {loading ? (
        <p className="text-gray-400 text-sm">불러오는 중...</p>
      ) : (
        <div className="grid grid-cols-3 gap-4">
          {filteredPlans.map(p => (
            <div key={p.id} className={`bg-white rounded-xl border-2 p-5 ${
              p.is_active ? "border-gray-200" : "border-gray-100 opacity-50"
            }`}>
              <div className="flex items-start justify-between mb-3">
                <div>
                  <div className="flex items-center gap-2">
                    <h3 className="font-bold text-gray-900">{p.name}</h3>
                    {!p.is_active && (
                      <span className="text-xs px-1.5 py-0.5 bg-gray-100 text-gray-500 rounded">비활성</span>
                    )}
                  </div>
                  {p.description && <p className="text-xs text-gray-500 mt-0.5">{p.description}</p>}
                </div>
              </div>

              <div className="mb-4">
                <span className="text-2xl font-bold text-gray-900">{krw(p.price)}</span>
                <span className="text-sm text-gray-500 ml-1">/ {BILLING_LABEL[p.billing_cycle] ?? p.billing_cycle}</span>
              </div>

              <div className="mb-3 px-2 py-1.5 bg-blue-50 rounded text-xs text-blue-900 flex items-center justify-between">
                <span>이미지 용량</span>
                <span className="font-bold">{formatQuota(p.r2_storage_quota_mb ?? 0)}</span>
              </div>

              {p.features.length > 0 && (
                <ul className="space-y-1 mb-4">
                  {p.features.map((f, i) => (
                    <li key={i} className="flex items-center gap-1.5 text-sm text-gray-600">
                      <span className="text-green-500 text-xs">✓</span>
                      {f}
                    </li>
                  ))}
                </ul>
              )}

              <div className="flex gap-2 pt-3 border-t border-gray-100">
                <button onClick={() => openEdit(p)}
                  className="flex-1 py-1.5 border border-gray-300 text-gray-600 rounded-lg text-xs hover:bg-gray-50">
                  수정
                </button>
                <button onClick={() => toggleActive(p)}
                  className={`flex-1 py-1.5 border rounded-lg text-xs ${
                    p.is_active
                      ? "border-orange-300 text-orange-600 hover:bg-orange-50"
                      : "border-green-300 text-green-600 hover:bg-green-50"
                  }`}>
                  {p.is_active ? "비활성화" : "활성화"}
                </button>
                <button onClick={() => deletePlan(p)}
                  className="py-1.5 px-2 border border-red-200 text-red-400 rounded-lg text-xs hover:bg-red-50">
                  삭제
                </button>
              </div>
            </div>
          ))}

          {filteredPlans.length === 0 && (
            <div className="col-span-3 text-center py-16 text-gray-300">
              등록된 플랜이 없습니다.
            </div>
          )}
        </div>
      )}

      {/* 플랜 등록/수정 모달 */}
      {showModal && (
        <Modal onClose={() => !saving && setShowModal(false)} size="md">
          <div className="p-5 border-b border-gray-100">
            <h3 className="text-lg font-bold text-gray-900">{editing ? "플랜 수정" : "플랜 추가"}</h3>
          </div>
          <div className="p-5 space-y-4">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs text-gray-600 mb-1">플랜명 *</label>
                <input type="text" value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                  placeholder="예: Basic, Pro, Enterprise"
                  className="w-full input-md" />
              </div>
              {!fixedVertical && (
                <div>
                  <label className="block text-xs text-gray-600 mb-1">Vertical *</label>
                  <select value={form.vertical} onChange={e => setForm(f => ({ ...f, vertical: e.target.value as Vertical }))}
                    className="w-full input-md">
                    {VERTICAL_TABS.map(t => (
                      <option key={t.key} value={t.key}>{t.label}</option>
                    ))}
                  </select>
                </div>
              )}
              <div>
                <label className="block text-xs text-gray-600 mb-1">결제 주기</label>
                <select value={form.billing_cycle} onChange={e => setForm(f => ({ ...f, billing_cycle: e.target.value }))}
                  className="w-full input-md">
                  <option value="monthly">월간</option>
                  <option value="yearly">연간</option>
                  <option value="one_time">일회성</option>
                </select>
              </div>
              <div>
                <label className="block text-xs text-gray-600 mb-1">가격 (원)</label>
                <input type="number" value={form.price} onChange={e => setForm(f => ({ ...f, price: Number(e.target.value) }))}
                  className="w-full input-md" />
              </div>
              <div>
                <label className="block text-xs text-gray-600 mb-1">정렬 순서</label>
                <input type="number" value={form.sort_order} onChange={e => setForm(f => ({ ...f, sort_order: Number(e.target.value) }))}
                  className="w-full input-md" />
              </div>
              <div>
                <label className="block text-xs text-gray-600 mb-1">
                  이미지 용량 한도 (MB) <span className="text-gray-400">— 0 = 무제한</span>
                </label>
                <input type="number" min={0} value={form.r2_storage_quota_mb}
                  onChange={e => setForm(f => ({ ...f, r2_storage_quota_mb: Number(e.target.value) }))}
                  placeholder="500"
                  className="w-full input-md" />
                <p className="text-[11px] text-gray-400 mt-0.5">{formatQuota(form.r2_storage_quota_mb)}</p>
              </div>
              <div className="col-span-2">
                <label className="block text-xs text-gray-600 mb-1">설명</label>
                <input type="text" value={form.description} onChange={e => setForm(f => ({ ...f, description: e.target.value }))}
                  className="w-full input-md" />
              </div>
              <div className="col-span-2">
                <label className="block text-xs text-gray-600 mb-1">기능 목록 (줄바꿈으로 구분)</label>
                <textarea value={form.features} onChange={e => setForm(f => ({ ...f, features: e.target.value }))}
                  rows={4} placeholder={"판매관리\n거래처관리\n상품관리\n재고관리"}
                  className="w-full input-md resize-none" />
              </div>
              <div className="col-span-2 flex items-center gap-2">
                <input type="checkbox" id="is_active" checked={form.is_active}
                  onChange={e => setForm(f => ({ ...f, is_active: e.target.checked }))}
                  className="rounded" />
                <label htmlFor="is_active" className="text-sm text-gray-700">활성 (계정 등록 시 선택 가능)</label>
              </div>
            </div>
          </div>
          <div className="flex gap-2 p-5 border-t border-gray-100">
            <button onClick={() => setShowModal(false)} disabled={saving}
              className="flex-1 py-2.5 border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50 text-sm">
              취소
            </button>
            <button onClick={handleSave} disabled={saving}
              className="flex-1 py-2.5 bg-primary text-white rounded-lg hover:bg-primary-hover disabled:opacity-50 font-medium text-sm">
              {saving ? "저장 중..." : editing ? "수정 완료" : "플랜 추가"}
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
