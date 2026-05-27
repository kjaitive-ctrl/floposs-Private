"use client";

import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";

type LegalKind = "terms" | "privacy" | "refund";

type LegalDocument = {
  id: string;
  kind: LegalKind;
  version: string;
  body: string;
  effective_at: string;
  notes: string | null;
  created_at: string;
};

const KIND_LABEL: Record<LegalKind, string> = {
  terms: "이용약관",
  privacy: "개인정보처리방침",
  refund: "환불정책",
};

export default function LegalPage() {
  const [activeKind, setActiveKind] = useState<LegalKind>("terms");
  const [docs, setDocs] = useState<Record<LegalKind, LegalDocument[]>>({ terms: [], privacy: [], refund: [] });
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<{ kind: LegalKind; version: string; body: string; notes: string } | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => { fetchAll(); }, []);

  async function fetchAll() {
    setLoading(true);
    const { data } = await supabase
      .from("legal_documents")
      .select("*")
      .order("effective_at", { ascending: false });
    if (data) {
      const grouped: Record<LegalKind, LegalDocument[]> = { terms: [], privacy: [], refund: [] };
      for (const d of data as LegalDocument[]) {
        if (d.kind in grouped) grouped[d.kind].push(d);
      }
      setDocs(grouped);
    }
    setLoading(false);
  }

  function startNewVersion() {
    const latest = docs[activeKind][0];
    setEditing({
      kind: activeKind,
      version: "",
      body: latest?.body ?? "",
      notes: "",
    });
  }

  async function handleSave() {
    if (!editing) return;
    if (!editing.version.trim()) { alert("버전을 입력해주세요. (예: v1.1, 2026-05-01)"); return; }
    if (!editing.body.trim()) { alert("본문을 입력해주세요."); return; }
    setSaving(true);
    const { error } = await supabase.from("legal_documents").insert({
      kind: editing.kind,
      version: editing.version.trim(),
      body: editing.body,
      notes: editing.notes.trim() || null,
    });
    setSaving(false);
    if (error) { alert("저장 실패: " + error.message); return; }
    setEditing(null);
    fetchAll();
  }

  const current = docs[activeKind][0];

  return (
    <div className="max-w-4xl">
      <div className="mb-6">
        <h2 className="text-2xl font-bold text-gray-900">약관 관리</h2>
        <p className="text-sm text-gray-500 mt-0.5">
          이용약관/개인정보처리방침 등 법적 문서. 변경 시 새 버전이 추가되고 이전 버전은 이력으로 보존됩니다.
        </p>
      </div>

      {/* 종류 탭 */}
      <div className="flex gap-2 mb-4">
        {(Object.keys(KIND_LABEL) as LegalKind[]).map(k => (
          <button key={k} onClick={() => { setActiveKind(k); setShowHistory(false); setEditing(null); }}
            className={`px-4 py-2 rounded-lg text-sm transition-colors ${
              activeKind === k
                ? "bg-primary text-white"
                : "bg-white border border-gray-300 text-gray-600 hover:bg-gray-50"
            }`}>
            {KIND_LABEL[k]}
            <span className={`ml-1 text-xs ${activeKind === k ? "text-white/80" : "text-gray-400"}`}>
              ({docs[k].length})
            </span>
          </button>
        ))}
      </div>

      {loading ? (
        <p className="text-gray-400 text-sm">불러오는 중...</p>
      ) : editing ? (
        <EditPanel editing={editing} setEditing={setEditing} onSave={handleSave} saving={saving}
          onCancel={() => setEditing(null)} />
      ) : (
        <div className="bg-white rounded-xl border border-gray-200 p-6">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h3 className="font-bold text-gray-900">현재 시행 중 — {KIND_LABEL[activeKind]}</h3>
              {current ? (
                <p className="text-xs text-gray-500 mt-0.5">
                  버전 {current.version} · 시행 {current.effective_at.slice(0, 10)}
                </p>
              ) : (
                <p className="text-xs text-orange-500 mt-0.5">아직 등록된 문서가 없습니다.</p>
              )}
            </div>
            <div className="flex gap-2">
              {docs[activeKind].length > 1 && (
                <button onClick={() => setShowHistory(v => !v)}
                  className="px-3 py-2 text-sm border border-gray-300 rounded-lg hover:bg-gray-50">
                  {showHistory ? "이력 닫기" : `이력 보기 (${docs[activeKind].length - 1}개)`}
                </button>
              )}
              <button onClick={startNewVersion}
                className="px-3 py-2 text-sm bg-primary text-white rounded-lg hover:bg-primary-hover">
                + 새 버전 등록
              </button>
            </div>
          </div>

          {current && (
            <pre className="text-sm text-gray-700 whitespace-pre-wrap leading-relaxed bg-gray-50 rounded-lg p-4 max-h-96 overflow-y-auto">
              {current.body}
            </pre>
          )}

          {showHistory && docs[activeKind].length > 1 && (
            <div className="mt-6 pt-4 border-t border-gray-200">
              <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-3">변경 이력</p>
              <div className="space-y-2">
                {docs[activeKind].slice(1).map(d => (
                  <details key={d.id} className="bg-gray-50 rounded-lg border border-gray-200">
                    <summary className="px-4 py-2 cursor-pointer text-sm flex justify-between">
                      <span className="font-medium text-gray-700">버전 {d.version}</span>
                      <span className="text-xs text-gray-500">{d.effective_at.slice(0, 10)}</span>
                    </summary>
                    {d.notes && <p className="px-4 pb-2 text-xs text-gray-500">{d.notes}</p>}
                    <pre className="mx-4 mb-3 text-xs text-gray-600 whitespace-pre-wrap leading-relaxed bg-white rounded p-3 max-h-64 overflow-y-auto">
                      {d.body}
                    </pre>
                  </details>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function EditPanel({
  editing, setEditing, onSave, saving, onCancel,
}: {
  editing: { kind: LegalKind; version: string; body: string; notes: string };
  setEditing: (v: { kind: LegalKind; version: string; body: string; notes: string }) => void;
  onSave: () => void;
  saving: boolean;
  onCancel: () => void;
}) {
  return (
    <div className="bg-white rounded-xl border border-gray-200 p-6 space-y-4">
      <div>
        <h3 className="font-bold text-gray-900">새 버전 — {KIND_LABEL[editing.kind]}</h3>
        <p className="text-xs text-gray-500 mt-0.5">저장하면 이 버전이 즉시 시행되고 이전 버전은 이력으로 보존됩니다.</p>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="block text-xs text-gray-600 mb-1">버전 *</label>
          <input type="text" value={editing.version}
            onChange={e => setEditing({ ...editing, version: e.target.value })}
            placeholder="v1.1, 2026-05-01 등 자유"
            className="w-full input-md" />
        </div>
        <div>
          <label className="block text-xs text-gray-600 mb-1">변경 사유 (내부 메모)</label>
          <input type="text" value={editing.notes}
            onChange={e => setEditing({ ...editing, notes: e.target.value })}
            placeholder="예: 결제 정책 변경 반영"
            className="w-full input-md" />
        </div>
      </div>

      <div>
        <label className="block text-xs text-gray-600 mb-1">본문 *</label>
        <textarea value={editing.body}
          onChange={e => setEditing({ ...editing, body: e.target.value })}
          rows={20} placeholder="본문 (plain text 또는 마크다운)"
          className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm font-mono leading-relaxed focus:outline-none focus:ring-2 focus:ring-primary-ring" />
      </div>

      <div className="flex gap-2">
        <button onClick={onSave} disabled={saving}
          className="px-5 py-2.5 bg-primary text-white text-sm rounded-lg hover:bg-primary-hover disabled:opacity-60 font-medium">
          {saving ? "저장 중..." : "이 버전 등록"}
        </button>
        <button onClick={onCancel} disabled={saving}
          className="px-5 py-2.5 border border-gray-300 text-gray-600 text-sm rounded-lg hover:bg-gray-50">
          취소
        </button>
      </div>
    </div>
  );
}
