"use client";

import { useEffect, useState, useCallback } from "react";
import { supabase } from "@/lib/supabase";
import { styles } from "@/common/styles";
import type { PlatformCurrency } from "@/lib/platformPricing";

// retail /dashboard/settings 안 "판매채널 관리" 서브섹션.
//   - tenant 자체 판매채널(지그재그, 식스티퍼센트 등) CRUD.
//   - /products 가격 토글에서 수수료 역산 + 통화환산에 사용.
//   - 마이그 215 (sales_platforms 테이블). ModelsSection.tsx 와 동일 패턴.

export type SalesPlatform = {
  id: string;
  tenant_id: string;
  name: string;
  fee_rate: number;
  currency: PlatformCurrency;
  sort_order: number;
  is_active: boolean;
};

type Draft = Omit<SalesPlatform, "id" | "tenant_id" | "sort_order">;

const EMPTY_DRAFT: Draft = {
  name: "",
  fee_rate: 0,
  currency: "KRW",
  is_active: true,
};

const CURRENCY_LABEL: Record<PlatformCurrency, string> = { KRW: "원화", JPY: "엔화", USD: "달러" };

export default function PlatformsSection({ tenantId }: { tenantId: string }) {
  const [platforms, setPlatforms] = useState<SalesPlatform[]>([]);
  const [loading, setLoading] = useState(true);
  const [showInactive, setShowInactive] = useState(false);
  const [editing, setEditing] = useState<SalesPlatform | null>(null);
  const [creating, setCreating] = useState(false);

  const fetchAll = useCallback(async () => {
    setLoading(true);
    const { data } = await supabase
      .from("sales_platforms")
      .select("*")
      .eq("tenant_id", tenantId)
      .order("is_active", { ascending: false })
      .order("sort_order", { ascending: true })
      .order("name", { ascending: true });
    setPlatforms((data ?? []) as SalesPlatform[]);
    setLoading(false);
  }, [tenantId]);

  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { fetchAll(); }, [fetchAll]);

  const visible = showInactive ? platforms : platforms.filter(p => p.is_active);

  return (
    <div className={`${styles.card} mt-4`}>
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-sm font-bold text-black">판매채널 관리</h2>
        <button onClick={() => setCreating(true)}
          className={styles.btnSmall + " whitespace-nowrap"}>
          + 채널 추가
        </button>
      </div>
      <p className="text-[11px] text-gray-500 mb-3">
        지그재그·식스티퍼센트 등 판매채널의 수수료/통화를 등록하면, /products 에서 가격을 채널 기준으로 환산해서 볼 수 있습니다.
      </p>

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
          {showInactive ? "등록된 채널이 없습니다." : "활성 채널이 없습니다."}
        </p>
      ) : (
        <ul className="divide-y divide-gray-100 border border-gray-100 rounded">
          {visible.map(p => (
            <li key={p.id}>
              <button onClick={() => setEditing(p)}
                className="w-full text-left px-3 py-2 hover:bg-gray-50 flex items-center gap-3">
                <span className={`text-sm font-medium ${p.is_active ? "text-black" : "text-gray-400"}`}>
                  {p.name}
                </span>
                <span className="text-[11px] text-gray-500 flex-1">
                  수수료 {p.fee_rate}% · {CURRENCY_LABEL[p.currency]}
                </span>
                {!p.is_active && (
                  <span className="text-[10px] px-1.5 py-0.5 bg-gray-100 text-gray-500 rounded">비활성</span>
                )}
              </button>
            </li>
          ))}
        </ul>
      )}

      {(creating || editing) && (
        <PlatformModal
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
function PlatformModal({
  tenantId, existing, onClose, onSaved,
}: {
  tenantId: string;
  existing: SalesPlatform | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const isEdit = !!existing;
  const [draft, setDraft] = useState<Draft>(() => {
    if (!existing) return EMPTY_DRAFT;
    const { id: _id, tenant_id: _tid, sort_order: _so, ...rest } = existing;
    void _id; void _tid; void _so;
    return rest;
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);

  function set<K extends keyof Draft>(k: K, v: Draft[K]) {
    setDraft(prev => ({ ...prev, [k]: v }));
  }

  async function handleSave() {
    setError("");
    if (!draft.name.trim()) { setError("채널명을 입력해주세요."); return; }
    if (draft.fee_rate < 0 || draft.fee_rate >= 100) { setError("수수료는 0~100 사이여야 합니다."); return; }
    setSaving(true);
    const payload = { ...draft, name: draft.name.trim() };
    let err;
    if (existing) {
      ({ error: err } = await supabase.from("sales_platforms").update(payload).eq("id", existing.id));
    } else {
      ({ error: err } = await supabase.from("sales_platforms").insert({ ...payload, tenant_id: tenantId }));
    }
    setSaving(false);
    if (err) { setError("저장 실패: " + err.message); return; }
    onSaved();
  }

  async function handleDelete() {
    if (!existing) return;
    setSaving(true);
    const { error: err } = await supabase.from("sales_platforms").delete().eq("id", existing.id);
    setSaving(false);
    if (err) { setError("삭제 실패: " + err.message); setConfirmDelete(false); return; }
    onSaved();
  }

  return (
    <div className={styles.modalOverlay} onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-lg max-h-[90vh] flex flex-col"
        onClick={e => e.stopPropagation()}>
        <div className="px-6 pt-6 pb-4 border-b border-gray-100">
          <h3 className="text-lg font-bold text-black">{isEdit ? "채널 수정" : "새 채널"}</h3>
        </div>

        <div className="overflow-y-auto flex-1 px-6 py-5 space-y-3">
          <div>
            <label className={styles.modalLabel}>채널명 *</label>
            <input value={draft.name} onChange={e => set("name", e.target.value)}
              placeholder="지그재그 / 식스티퍼센트 등"
              className={styles.modalInput} />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={styles.modalLabel}>수수료 (%)</label>
              <input type="number" inputMode="decimal" step="0.1" value={draft.fee_rate}
                onChange={e => set("fee_rate", Number(e.target.value))}
                className={styles.modalInput} />
            </div>
            <div>
              <label className={styles.modalLabel}>통화</label>
              <select value={draft.currency} onChange={e => set("currency", e.target.value as PlatformCurrency)}
                className={styles.modalInput}>
                <option value="KRW">원화 (KRW)</option>
                <option value="JPY">엔화 (JPY)</option>
                <option value="USD">달러 (USD)</option>
              </select>
            </div>
          </div>

          <label className="flex items-center gap-2 text-sm text-black mt-2">
            <input type="checkbox" checked={draft.is_active}
              onChange={e => set("is_active", e.target.checked)}
              className="accent-primary" />
            활성 (/products 토글에 노출)
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
