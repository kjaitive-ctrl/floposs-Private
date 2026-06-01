"use client";

import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import { styles } from "@/common/styles";

// MD기능 [멘트] — 마이그 195 기준 단순 메모 + 자동 prefill.
//   - tenant 가 starter text 정의 → 신규 작성 시 자동 prefill (= form 자동입력).
//   - 사용자는 textarea 에서 자유 편집. 라벨 / 폼 강제 X.
//   - 나중에 AI 프롬프트로 그대로 전달 (text 1 덩어리).
//   - "양식 편집" 토글로 tenant 의 starter text 직접 수정.
// 박제: products.comment_data TEXT + tenants.comment_template TEXT.

type Props = {
  tenantId: string;
  productId: string;
  productName: string;
  onClose: () => void;
  onSaved: () => void;
};

// 195 적용 전엔 DB가 JSONB (array/object). 적용 후엔 TEXT. 둘 다 안전 변환.
// JSONB array of labels  → "label:\n..." (template starter 형식)
// JSONB object {k: v}    → "k: v\n..."  (메모 형식)
function safeText(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v;
  if (Array.isArray(v)) {
    return v.filter(Boolean).map(String).map(s => s + ":").join("\n");
  }
  if (typeof v === "object") {
    return Object.entries(v as Record<string, unknown>)
      .map(([k, val]) => `${k}: ${val ?? ""}`).join("\n");
  }
  return String(v);
}

export default function CommentModal({ tenantId, productId, productName, onClose, onSaved }: Props) {
  const [loading, setLoading] = useState(true);
  const [template, setTemplate] = useState("");
  const [memo, setMemo] = useState("");
  const [editMode, setEditMode] = useState(false);
  const [draftTemplate, setDraftTemplate] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [{ data: tenant }, { data: product }] = await Promise.all([
        supabase.from("tenants").select("comment_template").eq("id", tenantId).maybeSingle(),
        supabase.from("products").select("comment_data").eq("id", productId).maybeSingle(),
      ]);
      if (cancelled) return;
      // DB 상태 무관 (JSONB / TEXT 둘 다) 안전 변환
      const tpl = safeText(tenant?.comment_template);
      const data = safeText(product?.comment_data);
      setTemplate(tpl);
      setDraftTemplate(tpl);
      // 빈 메모 + 양식 있으면 자동 prefill (= 양식 그대로 시작)
      setMemo(data || tpl);
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [tenantId, productId]);

  async function handleSaveMemo() {
    setSaving(true);
    await supabase.from("products")
      .update({ comment_data: memo, updated_at: new Date().toISOString() })
      .eq("id", productId);
    setSaving(false);
    onSaved();
  }

  async function handleSaveTemplate() {
    setSaving(true);
    await supabase.from("tenants")
      .update({ comment_template: draftTemplate })
      .eq("id", tenantId);
    setTemplate(draftTemplate);
    setSaving(false);
    setEditMode(false);
  }

  function resetToTemplate() {
    if (!template) return;
    if (memo.trim() && !confirm("현재 메모를 양식으로 덮어씁니다. 진행할까요?")) return;
    setMemo(template);
  }

  return (
    {/* 바깥 클릭 닫기 없음 — 글 쓰다가 밖 클릭으로 초기화되는 사고 방지.
        닫기는 하단 "닫기"/저장 버튼으로만. */}
    <div className={styles.modalOverlay}>
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-lg max-h-[90vh] flex flex-col">
        <div className="px-6 pt-6 pb-4 border-b border-gray-100 flex items-start justify-between">
          <div>
            <h3 className="text-lg font-bold text-black mb-1">멘트</h3>
            <p className="text-xs text-gray-500">{productName}</p>
          </div>
          <button onClick={() => setEditMode(!editMode)}
            className="text-xs text-gray-500 hover:text-black underline whitespace-nowrap">
            {editMode ? "← 메모 입력" : "양식 편집"}
          </button>
        </div>

        <div className="overflow-y-auto flex-1 px-6 py-5 space-y-3">
          {loading ? (
            <p className="text-xs text-gray-400 text-center py-6">불러오는 중...</p>
          ) : editMode ? (
            <>
              <p className="text-xs text-gray-500">
                새 멘트 작성 시 이 양식이 자동으로 채워집니다. 예시: <code className="bg-gray-100 px-1 rounded">원단:\n착용감:\n계절감:</code>
              </p>
              <textarea value={draftTemplate} onChange={e => setDraftTemplate(e.target.value)}
                rows={10}
                placeholder="원단:&#10;착용감:&#10;계절감:&#10;"
                className={styles.modalInput + " resize-none font-mono text-xs leading-relaxed"} />
            </>
          ) : (
            <>
              <div className="flex items-center justify-between">
                <p className="text-xs text-gray-500">메모 (자유 편집)</p>
                {template && (
                  <button onClick={resetToTemplate}
                    className="text-[11px] text-gray-500 hover:text-black underline">
                    양식으로 초기화
                  </button>
                )}
              </div>
              <textarea value={memo} onChange={e => setMemo(e.target.value)}
                rows={12}
                placeholder={template || "양식이 없습니다. 우상단 '양식 편집' 으로 starter text 를 설정해보세요."}
                className={styles.modalInput + " resize-none text-sm leading-relaxed"} />
              <p className="text-[11px] text-gray-400">
                AI 가 나중에 이 텍스트 그대로 받아 상세 MD 멘트를 생성합니다. ([[AI 크레딧 시스템 - 휴면]])
              </p>
            </>
          )}
        </div>

        <div className="px-6 pb-6 pt-3 border-t border-gray-100 flex gap-2">
          <button onClick={onClose} disabled={saving}
            className={`${styles.btnSecondary} flex-1 py-2.5`}>
            닫기
          </button>
          {editMode ? (
            <button onClick={handleSaveTemplate} disabled={saving}
              className={`${styles.btnPrimary} flex-1 py-2.5`}>
              {saving ? "저장 중..." : "양식 저장"}
            </button>
          ) : (
            <button onClick={handleSaveMemo} disabled={saving}
              className={`${styles.btnPrimary} flex-1 py-2.5`}>
              {saving ? "저장 중..." : "저장"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
