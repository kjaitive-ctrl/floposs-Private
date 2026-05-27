"use client";

// 관리자(super_admin) TEST 페이지 — 사장 대시보드 안의 멘트/안내문 편집 placeholder.
// 첫 사용처: 매장 계정 운영 가이드 항목.

import { useEffect, useState, useCallback } from "react";
import { supabase } from "@/lib/supabase";

type DashboardTexts = {
  staff_guide_items?: string[];
  // 추후 다른 멘트 키 추가 가능
};

export default function AdminTestPage() {
  const [texts, setTexts] = useState<DashboardTexts>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    const { data } = await supabase
      .from("platform_settings")
      .select("dashboard_texts")
      .eq("id", 1)
      .maybeSingle();
    setTexts((data?.dashboard_texts as DashboardTexts) ?? {});
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  async function save() {
    setSaving(true);
    setError("");
    const { error } = await supabase
      .from("platform_settings")
      .update({ dashboard_texts: texts })
      .eq("id", 1);
    setSaving(false);
    if (error) { setError(error.message); return; }
    setSavedAt(new Date().toLocaleTimeString("ko-KR"));
  }

  function updateGuideItem(idx: number, value: string) {
    const items = [...(texts.staff_guide_items ?? [])];
    items[idx] = value;
    setTexts({ ...texts, staff_guide_items: items });
  }

  function addGuideItem() {
    const items = [...(texts.staff_guide_items ?? []), ""];
    setTexts({ ...texts, staff_guide_items: items });
  }

  function removeGuideItem(idx: number) {
    const items = (texts.staff_guide_items ?? []).filter((_, i) => i !== idx);
    setTexts({ ...texts, staff_guide_items: items });
  }

  if (loading) return <p className="text-gray-500 text-sm">불러오는 중...</p>;

  const guideItems = texts.staff_guide_items ?? [];

  return (
    <div className="max-w-3xl space-y-6">
      <div>
        <h2 className="text-2xl font-bold text-gray-900">TEST — 대시보드 멘트 편집</h2>
        <p className="text-sm text-gray-500 mt-1">사장 대시보드 안의 안내문/가이드를 여기서 직접 편집. platform_settings.dashboard_texts (JSONB) 박제.</p>
      </div>

      <section className="bg-white rounded-xl border border-gray-200 p-5 space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold text-gray-700">매장 계정 운영 가이드</h3>
          <span className="text-[10px] text-gray-400">key: <code>staff_guide_items</code></span>
        </div>
        <p className="text-xs text-gray-500">사장이 [구독 및 설정] → [매장 계정] 탭 하단에 보는 가이드 항목들. 각 줄 = 한 항목 (•)</p>

        <ul className="space-y-2">
          {guideItems.map((item, i) => (
            <li key={i} className="flex gap-2 items-start">
              <span className="text-xs text-gray-400 pt-2 w-4">•</span>
              <textarea
                value={item}
                onChange={e => updateGuideItem(i, e.target.value)}
                rows={2}
                className="flex-1 input-md text-xs resize-none"
                placeholder="가이드 항목"
              />
              <button
                onClick={() => removeGuideItem(i)}
                className="text-[11px] px-2 py-1 border border-red-200 text-red-500 rounded hover:bg-red-50 transition-colors shrink-0"
              >삭제</button>
            </li>
          ))}
        </ul>

        <button
          onClick={addGuideItem}
          className="w-full py-2 border border-dashed border-gray-300 rounded-lg text-xs text-gray-500 hover:bg-gray-50 hover:text-gray-700 transition-colors"
        >+ 항목 추가</button>
      </section>

      <div className="flex items-center gap-3 pt-2">
        <button
          onClick={save}
          disabled={saving}
          className="px-5 py-2.5 bg-primary text-white rounded-lg hover:bg-primary-hover disabled:opacity-50 text-sm font-medium"
        >{saving ? "저장 중..." : "저장"}</button>
        {savedAt && <span className="text-xs text-green-600">{savedAt} 저장됨</span>}
        {error && <span className="text-xs text-red-500">{error}</span>}
      </div>
    </div>
  );
}
