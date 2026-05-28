"use client";

import { useEffect, useState, useCallback } from "react";
import { supabase } from "@/lib/supabase";
import { styles } from "@/common/styles";

// retail /dashboard/settings 안 "모델 관리" 서브섹션.
//   - tenant 자체 모델 풀 CRUD.
//   - 활성 toggle = ShootModal dropdown 노출 여부.
//   - 마이그 196 (models 테이블).

export type Model = {
  id: string;
  tenant_id: string;
  name: string;
  height: number | null;
  weight: number | null;
  top_size: string | null;
  bottom_size: string | null;
  shoe_size: number | null;
  body_type: string | null;
  phone: string | null;
  is_active: boolean;
};

type Draft = Omit<Model, "id" | "tenant_id">;

const EMPTY_DRAFT: Draft = {
  name: "",
  height: null,
  weight: null,
  top_size: null,
  bottom_size: null,
  shoe_size: null,
  body_type: null,
  phone: null,
  is_active: true,
};

export default function ModelsSection({ tenantId }: { tenantId: string }) {
  const [models, setModels] = useState<Model[]>([]);
  const [loading, setLoading] = useState(true);
  const [showInactive, setShowInactive] = useState(false);
  const [editing, setEditing] = useState<Model | null>(null);
  const [creating, setCreating] = useState(false);

  const fetchAll = useCallback(async () => {
    setLoading(true);
    const { data } = await supabase
      .from("models")
      .select("*")
      .eq("tenant_id", tenantId)
      .order("is_active", { ascending: false })
      .order("name", { ascending: true });
    setModels((data ?? []) as Model[]);
    setLoading(false);
  }, [tenantId]);

  useEffect(() => { fetchAll(); }, [fetchAll]);

  const visible = showInactive ? models : models.filter(m => m.is_active);

  return (
    <div className={`${styles.card}`}>
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-sm font-bold text-black">모델 관리</h2>
        <button onClick={() => setCreating(true)}
          className={styles.btnSmall + " whitespace-nowrap"}>
          + 모델 추가
        </button>
      </div>

      <div className="flex items-center justify-end mb-2">
        <label className="flex items-center gap-1.5 text-[11px] text-gray-500 cursor-pointer">
          <input type="checkbox" checked={showInactive}
            onChange={e => setShowInactive(e.target.checked)}
            className="accent-primary" />
          비활성 포함
        </label>
      </div>

      {loading ? (
        <p className="text-xs text-gray-400 text-center py-4">불러오는 중...</p>
      ) : visible.length === 0 ? (
        <p className="text-xs text-gray-400 text-center py-6">
          {showInactive ? "등록된 모델이 없습니다." : "활성 모델이 없습니다."}
        </p>
      ) : (
        <ul className="divide-y divide-gray-100 border border-gray-100 rounded">
          {visible.map(m => (
            <li key={m.id}>
              <button onClick={() => setEditing(m)}
                className="w-full text-left px-3 py-2 hover:bg-gray-50 flex items-center gap-3">
                <span className={`text-sm font-medium ${m.is_active ? "text-black" : "text-gray-400"}`}>
                  {m.name}
                </span>
                <span className="text-[11px] text-gray-500 flex-1">
                  {[m.height && `${m.height}cm`, m.weight && `${m.weight}kg`,
                    m.top_size && `상의 ${m.top_size}`, m.bottom_size && `하의 ${m.bottom_size}`,
                    m.shoe_size && `${m.shoe_size}mm`, m.body_type]
                    .filter(Boolean).join(" · ")}
                </span>
                {!m.is_active && (
                  <span className="text-[10px] px-1.5 py-0.5 bg-gray-100 text-gray-500 rounded">비활성</span>
                )}
              </button>
            </li>
          ))}
        </ul>
      )}

      {(creating || editing) && (
        <ModelModal
          tenantId={tenantId}
          existing={editing}
          onClose={() => { setCreating(false); setEditing(null); }}
          onSaved={() => { setCreating(false); setEditing(null); fetchAll(); }}
        />
      )}
    </div>
  );
}

// ──────────────────────────────────────────────────
function ModelModal({
  tenantId, existing, onClose, onSaved,
}: {
  tenantId: string;
  existing: Model | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const isEdit = !!existing;
  const [draft, setDraft] = useState<Draft>(() => {
    if (!existing) return EMPTY_DRAFT;
    const { id: _id, tenant_id: _tid, ...rest } = existing;
    void _id; void _tid;
    return rest;
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);

  function set<K extends keyof Draft>(k: K, v: Draft[K]) {
    setDraft(prev => ({ ...prev, [k]: v }));
  }
  function setInt(k: keyof Draft, v: string) {
    const n = v.trim() === "" ? null : Number(v);
    if (n !== null && (isNaN(n) || n < 0)) return;
    setDraft(prev => ({ ...prev, [k]: n } as Draft));
  }
  function setText(k: keyof Draft, v: string) {
    setDraft(prev => ({ ...prev, [k]: v.trim() === "" ? null : v } as Draft));
  }

  async function handleSave() {
    setError("");
    if (!draft.name.trim()) { setError("모델명을 입력해주세요."); return; }
    setSaving(true);
    const payload = { ...draft, name: draft.name.trim() };
    let err;
    if (existing) {
      ({ error: err } = await supabase.from("models").update(payload).eq("id", existing.id));
    } else {
      ({ error: err } = await supabase.from("models").insert({ ...payload, tenant_id: tenantId }));
    }
    setSaving(false);
    if (err) { setError("저장 실패: " + err.message); return; }
    onSaved();
  }

  async function handleDelete() {
    if (!existing) return;
    setSaving(true);
    const { error: err } = await supabase.from("models").delete().eq("id", existing.id);
    setSaving(false);
    if (err) {
      setError("삭제 실패: " + err.message + " (촬영 이력에 사용 중이면 비활성 처리하세요)");
      setConfirmDelete(false);
      return;
    }
    onSaved();
  }

  return (
    <div className={styles.modalOverlay} onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-lg max-h-[90vh] flex flex-col"
        onClick={e => e.stopPropagation()}>
        <div className="px-6 pt-6 pb-4 border-b border-gray-100">
          <h3 className="text-lg font-bold text-black">{isEdit ? "모델 수정" : "새 모델"}</h3>
        </div>

        <div className="overflow-y-auto flex-1 px-6 py-5 space-y-3">
          <div>
            <label className={styles.modalLabel}>모델명 *</label>
            <input value={draft.name} onChange={e => set("name", e.target.value)}
              placeholder="활동명 / 실명"
              className={styles.modalInput} />
          </div>

          <div className="grid grid-cols-3 gap-3">
            <div>
              <label className={styles.modalLabel}>키 (cm)</label>
              <input type="number" inputMode="numeric" value={draft.height ?? ""}
                onChange={e => setInt("height", e.target.value)}
                className={styles.modalInput} />
            </div>
            <div>
              <label className={styles.modalLabel}>몸무게 (kg)</label>
              <input type="number" inputMode="numeric" value={draft.weight ?? ""}
                onChange={e => setInt("weight", e.target.value)}
                className={styles.modalInput} />
            </div>
            <div>
              <label className={styles.modalLabel}>신발 (mm)</label>
              <input type="number" inputMode="numeric" value={draft.shoe_size ?? ""}
                onChange={e => setInt("shoe_size", e.target.value)}
                placeholder="230"
                className={styles.modalInput} />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={styles.modalLabel}>상의 사이즈</label>
              <input value={draft.top_size ?? ""} onChange={e => setText("top_size", e.target.value)}
                placeholder="S / M / 55 등"
                className={styles.modalInput} />
            </div>
            <div>
              <label className={styles.modalLabel}>하의 사이즈</label>
              <input value={draft.bottom_size ?? ""} onChange={e => setText("bottom_size", e.target.value)}
                placeholder="S / 27 등"
                className={styles.modalInput} />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={styles.modalLabel}>체형</label>
              <input value={draft.body_type ?? ""} onChange={e => setText("body_type", e.target.value)}
                placeholder="슬림 / 표준 등"
                className={styles.modalInput} />
            </div>
            <div>
              <label className={styles.modalLabel}>연락처</label>
              <input value={draft.phone ?? ""} onChange={e => setText("phone", e.target.value)}
                placeholder="010-0000-0000"
                className={styles.modalInput} />
            </div>
          </div>

          <label className="flex items-center gap-2 text-sm text-black mt-2">
            <input type="checkbox" checked={draft.is_active}
              onChange={e => set("is_active", e.target.checked)}
              className="accent-primary" />
            활성 (촬영 드롭다운 노출)
          </label>

          {error && <p className={styles.msgError}>{error}</p>}
        </div>

        <div className="px-6 py-4 border-t border-gray-100 flex gap-2">
          {isEdit && (
            confirmDelete ? (
              <>
                <button onClick={() => setConfirmDelete(false)} disabled={saving}
                  className={styles.btnSecondary}>아니오</button>
                <button onClick={handleDelete} disabled={saving}
                  className="px-3 py-1.5 bg-red-500 text-white text-xs rounded-lg hover:bg-red-600">
                  {saving ? "삭제 중..." : "정말 삭제"}
                </button>
              </>
            ) : (
              <button onClick={() => setConfirmDelete(true)} disabled={saving}
                className="px-3 py-1.5 border border-red-300 text-red-600 text-xs rounded-lg hover:bg-red-50">
                삭제
              </button>
            )
          )}
          <div className="ml-auto flex gap-2">
            <button onClick={onClose} disabled={saving} className={styles.btnSecondary}>취소</button>
            <button onClick={handleSave} disabled={saving} className={styles.btnPrimary}>
              {saving ? "저장 중..." : "저장"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
