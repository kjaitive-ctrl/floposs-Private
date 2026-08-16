"use client";

import { useEffect, useState, useCallback } from "react";
import { Modal } from "@floposs/ui";
import { supabase } from "@/lib/supabase";

// 측정 카테고리 관리 (super_admin 전용).
//   - measurement_templates 에서 tenant_id IS NULL (시스템 공통)만 관리.
//   - 추가/수정/비활성/정렬 — 저장 시점에 모든 retail tenant 의 dropdown + SizeModal 즉시 반영.
//   - 중앙 source of truth ([[feedback_central_source_of_truth]]).
//   - 단일화 원칙 — tenant 자체 카테고리 X. 사장님 1곳에서만 관리.

type Template = {
  id: string;
  category: string;
  field_keys: string[];
  required_keys: string[];
  sort_order: number;
  is_active: boolean;
  updated_at: string | null;
};

const PRIMARY_BTN = "px-3 py-1.5 bg-primary text-white text-xs rounded-lg hover:bg-primary-hover disabled:opacity-50";
const SECONDARY_BTN = "px-3 py-1.5 border border-gray-300 text-gray-700 text-xs rounded-lg hover:bg-gray-50";
const INPUT = "w-full px-3 py-2 border border-gray-300 rounded-lg text-sm text-black focus:outline-none focus:ring-2 focus:ring-primary-ring";

export default function MeasurementTemplatesPage() {
  const [rows, setRows] = useState<Template[]>([]);
  const [loading, setLoading] = useState(true);
  const [showInactive, setShowInactive] = useState(false);
  const [editing, setEditing] = useState<Template | null>(null);
  const [creating, setCreating] = useState(false);
  const [chipRegistering, setChipRegistering] = useState(false);

  const fetchAll = useCallback(async () => {
    setLoading(true);
    const { data } = await supabase
      .from("measurement_templates")
      .select("id, category, field_keys, required_keys, sort_order, is_active, updated_at")
      .is("tenant_id", null)
      .order("sort_order", { ascending: true });
    setRows((data ?? []) as Template[]);
    setLoading(false);
  }, []);

  useEffect(() => { fetchAll(); }, [fetchAll]);

  const visible = showInactive ? rows : rows.filter(r => r.is_active);

  // 마스터 칩 풀 — 모든 카테고리의 distinct field_keys (활성/비활성 무관)
  const chipPool = Array.from(
    new Set(rows.flatMap(r => r.field_keys))
  ).sort((a, b) => a.localeCompare(b, "ko"));

  return (
    <div className="max-w-5xl">
      <div className="mb-6">
        <h2 className="text-2xl font-bold text-gray-900">측정 카테고리 관리</h2>
        <p className="text-sm text-gray-500 mt-0.5">
          여기서 추가/수정한 카테고리는 모든 retail tenant 의 카테고리 dropdown + 사이즈 모달에 즉시 반영됩니다.
          ([[중앙 1곳 변경 = 모든 곳 자동 반영]])
        </p>
      </div>

      <div className="flex items-center gap-3 mb-4">
        <button onClick={() => setCreating(true)} className={PRIMARY_BTN}>
          + 신규 카테고리
        </button>
        <button onClick={() => setChipRegistering(true)} className={SECONDARY_BTN}>
          + 새 측정 필드 (칩)
        </button>
        <span className="text-xs text-gray-400">마스터 칩 풀 {chipPool.length}개</span>
        <label className="flex items-center gap-1.5 text-xs text-gray-600 cursor-pointer ml-auto">
          <input type="checkbox" checked={showInactive}
            onChange={e => setShowInactive(e.target.checked)}
            className="accent-primary" />
          비활성 포함
        </label>
        <button onClick={fetchAll} className={SECONDARY_BTN}>새로고침</button>
      </div>

      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
        {loading ? (
          <p className="text-center py-10 text-gray-400 text-sm">불러오는 중...</p>
        ) : visible.length === 0 ? (
          <p className="text-center py-10 text-gray-400 text-sm">
            {showInactive ? "카테고리가 없습니다." : "활성 카테고리가 없습니다. (비활성 포함 toggle 해보세요)"}
          </p>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b border-gray-200">
              <tr className="text-left">
                <th className="px-4 py-3 text-gray-600 font-medium w-16 text-center">정렬</th>
                <th className="px-4 py-3 text-gray-600 font-medium">카테고리</th>
                <th className="px-4 py-3 text-gray-600 font-medium">측정 필드</th>
                <th className="px-4 py-3 text-gray-600 font-medium w-20 text-center">필수</th>
                <th className="px-4 py-3 text-gray-600 font-medium w-20 text-center">상태</th>
                <th className="px-4 py-3 w-24"></th>
              </tr>
            </thead>
            <tbody>
              {visible.map(t => (
                <tr key={t.id} className="border-b border-gray-100 hover:bg-gray-50">
                  <td className="px-4 py-3 text-center text-gray-500">{t.sort_order}</td>
                  <td className="px-4 py-3 font-medium text-gray-900">{t.category}</td>
                  <td className="px-4 py-3 text-gray-600">
                    <span className="text-xs">{t.field_keys.join(", ") || "(없음)"}</span>
                    <span className="ml-1 text-gray-400 text-xs">({t.field_keys.length}개)</span>
                  </td>
                  <td className="px-4 py-3 text-center text-xs text-red-600">
                    {t.required_keys.join(", ") || "—"}
                  </td>
                  <td className="px-4 py-3 text-center">
                    {t.is_active ? (
                      <span className="text-xs px-2 py-0.5 bg-green-100 text-green-700 rounded">활성</span>
                    ) : (
                      <span className="text-xs px-2 py-0.5 bg-gray-100 text-gray-500 rounded">비활성</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <button onClick={() => setEditing(t)}
                      className="text-xs text-primary hover:underline">수정</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {(creating || editing) && (
        <TemplateModal
          existing={editing}
          allTemplates={rows}
          chipPool={chipPool}
          onClose={() => { setCreating(false); setEditing(null); }}
          onSaved={() => { setCreating(false); setEditing(null); fetchAll(); }}
        />
      )}
      {chipRegistering && (
        <ChipRegisterModal
          allTemplates={rows}
          onClose={() => setChipRegistering(false)}
          onSaved={() => { setChipRegistering(false); fetchAll(); }}
        />
      )}
    </div>
  );
}

// ──────────────────────────────────────────────────
// 추가/수정 모달
// ──────────────────────────────────────────────────
type FieldDraft = { label: string; required: boolean };

function TemplateModal({
  existing, allTemplates, chipPool, onClose, onSaved,
}: {
  existing: Template | null;
  allTemplates: Template[];
  chipPool: string[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const isEdit = !!existing;
  const [category, setCategory] = useState(existing?.category ?? "");
  const [sortOrder, setSortOrder] = useState<number>(
    existing?.sort_order ?? (Math.max(0, ...allTemplates.map(t => t.sort_order)) + 1)
  );
  const [isActive, setIsActive] = useState(existing?.is_active ?? true);
  const [fields, setFields] = useState<FieldDraft[]>(() => {
    if (!existing) return [{ label: "총장", required: true }];
    const requiredSet = new Set(existing.required_keys);
    return existing.field_keys.map(k => ({ label: k, required: requiredSet.has(k) }));
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);

  // 활성 칩 라벨 집합 (chipPool 토글 판단용)
  const activeLabels = new Set(fields.map(f => f.label));

  function toggleChip(label: string) {
    if (activeLabels.has(label)) {
      setFields(fields.filter(f => f.label !== label));
    } else {
      setFields([...fields, { label, required: false }]);
    }
    setError("");
  }
  function removeField(idx: number) {
    setFields(fields.filter((_, i) => i !== idx));
  }
  function moveField(idx: number, dir: -1 | 1) {
    const next = [...fields];
    const target = idx + dir;
    if (target < 0 || target >= next.length) return;
    [next[idx], next[target]] = [next[target], next[idx]];
    setFields(next);
  }
  function toggleRequired(idx: number) {
    setFields(fields.map((f, i) => i === idx ? { ...f, required: !f.required } : f));
  }

  async function handleSave() {
    setError("");
    const name = category.trim();
    if (!name) { setError("카테고리명을 입력해주세요."); return; }
    if (fields.length === 0) { setError("측정 필드를 1개 이상 추가해주세요."); return; }
    // 중복 카테고리명 가드 (수정 시 자기 자신 제외)
    if (allTemplates.some(t => t.category === name && t.id !== existing?.id)) {
      setError(`이미 있는 카테고리명: ${name}`);
      return;
    }

    setSaving(true);
    const payload = {
      category: name,
      field_keys: fields.map(f => f.label),
      required_keys: fields.filter(f => f.required).map(f => f.label),
      sort_order: sortOrder,
      is_active: isActive,
      updated_at: new Date().toISOString(),
    };

    let err;
    if (existing) {
      ({ error: err } = await supabase
        .from("measurement_templates")
        .update(payload)
        .eq("id", existing.id));
    } else {
      ({ error: err } = await supabase
        .from("measurement_templates")
        .insert({ ...payload, tenant_id: null }));
    }
    setSaving(false);
    if (err) { setError("저장 실패: " + err.message); return; }
    onSaved();
  }

  async function handleDelete() {
    if (!existing) return;
    setSaving(true);
    const { error: err } = await supabase
      .from("measurement_templates")
      .delete()
      .eq("id", existing.id);
    setSaving(false);
    if (err) {
      setError("삭제 실패: " + err.message + " (관련 박제 데이터가 있으면 비활성 처리하세요)");
      setConfirmDelete(false);
      return;
    }
    onSaved();
  }

  return (
    <Modal size="2xl" onClose={onClose}>
      <div className="flex flex-col max-h-[85vh]">
        <div className="px-6 pt-6 pb-4 border-b border-gray-100">
          <h3 className="text-lg font-bold text-gray-900">
            {isEdit ? "카테고리 수정" : "새 카테고리"}
          </h3>
          <p className="text-xs text-gray-500 mt-0.5">
            저장 즉시 모든 retail tenant 에 반영됩니다.
          </p>
        </div>

        <div className="overflow-y-auto flex-1 px-6 py-5 space-y-4">
          <div className="grid grid-cols-3 gap-3">
            <div className="col-span-2">
              <label className="block text-xs text-gray-600 mb-1">카테고리명 *</label>
              <input type="text" value={category} onChange={e => setCategory(e.target.value)}
                placeholder="예: 상의 / 셔츠"
                className={INPUT} />
              <p className="text-[11px] text-gray-400 mt-1">상위/세부 구분 시 &quot; / &quot; 사용 권장</p>
            </div>
            <div>
              <label className="block text-xs text-gray-600 mb-1">정렬순서</label>
              <input type="number" value={sortOrder}
                onChange={e => setSortOrder(Number(e.target.value) || 0)}
                className={INPUT} />
            </div>
          </div>

          <label className="flex items-center gap-2 text-sm text-gray-700">
            <input type="checkbox" checked={isActive} onChange={e => setIsActive(e.target.checked)}
              className="accent-primary" />
            활성 (체크 해제 시 retail dropdown 에 안 보임)
          </label>

          {/* 필드 편집 — 칩 풀에서 토글 (오타 방지 — 중앙화 원칙) */}
          <div>
            <label className="block text-xs text-gray-600 mb-2">
              측정 필드 — 마스터 칩 풀에서 클릭 토글 (활성=이 카테고리에 포함)
            </label>
            <div className="flex flex-wrap gap-1.5 p-2.5 bg-gray-50 rounded mb-3 max-h-40 overflow-y-auto">
              {chipPool.length === 0 ? (
                <span className="text-xs text-gray-400">
                  마스터 칩 풀이 비어있습니다. 페이지 상단 [+ 새 측정 필드] 로 먼저 등록하세요.
                </span>
              ) : chipPool.map(label => {
                const on = activeLabels.has(label);
                return (
                  <button key={label} onClick={() => toggleChip(label)}
                    className={"text-xs px-2 py-1 rounded border transition-colors " + (
                      on
                        ? "bg-primary text-white border-primary hover:opacity-90"
                        : "bg-white text-gray-600 border-gray-300 hover:border-gray-500"
                    )}>
                    {label}
                  </button>
                );
              })}
            </div>
            <p className="text-[11px] text-gray-400 mb-2">
              새 필드 등록은 상단 [+ 새 측정 필드 (칩)] 버튼으로. 칩 비활성화해도 박제 데이터는 보존됩니다.
            </p>

            <label className="block text-xs text-gray-600 mb-1.5">활성 필드 — 순서 / 필수 토글</label>
            <ul className="space-y-1">
              {fields.length === 0 ? (
                <li className="text-xs text-gray-400 text-center py-3 bg-gray-50 rounded">
                  위 칩 풀에서 필드를 선택해주세요.
                </li>
              ) : fields.map((f, idx) => (
                <li key={f.label} className="flex items-center gap-2 px-3 py-2 bg-gray-50 rounded">
                  <span className="text-xs text-gray-400 w-5">{idx + 1}.</span>
                  <label className="flex items-center gap-1 text-xs text-gray-600 w-16 cursor-pointer">
                    <input type="checkbox" checked={f.required}
                      onChange={() => toggleRequired(idx)}
                      className="accent-red-500" />
                    필수
                  </label>
                  <span className="flex-1 text-sm text-black">
                    {f.required && <span className="text-red-500 mr-0.5">*</span>}
                    {f.label}
                  </span>
                  <button onClick={() => moveField(idx, -1)} disabled={idx === 0}
                    className="text-xs text-gray-500 hover:text-black disabled:opacity-30 px-1">↑</button>
                  <button onClick={() => moveField(idx, 1)} disabled={idx === fields.length - 1}
                    className="text-xs text-gray-500 hover:text-black disabled:opacity-30 px-1">↓</button>
                  <button onClick={() => removeField(idx)}
                    className="text-xs text-red-500 hover:text-red-700 px-1">×</button>
                </li>
              ))}
            </ul>
          </div>

          {error && (
            <p className="text-sm text-red-500 bg-red-50 border border-red-200 rounded p-2">{error}</p>
          )}
        </div>

        <div className="px-6 py-4 border-t border-gray-100 flex gap-2">
          {isEdit && (
            confirmDelete ? (
              <>
                <button onClick={() => setConfirmDelete(false)} disabled={saving}
                  className={SECONDARY_BTN}>아니오</button>
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
            <button onClick={onClose} disabled={saving} className={SECONDARY_BTN}>취소</button>
            <button onClick={handleSave} disabled={saving} className={PRIMARY_BTN}>
              {saving ? "저장 중..." : "저장"}
            </button>
          </div>
        </div>
      </div>
    </Modal>
  );
}

// ──────────────────────────────────────────────────
// 새 측정 필드 (칩) 등록 모달 — 필드명 + 카테고리 다중 선택 → 일괄 append
// 사장 결정 (2026-05-29): 자유 텍스트 input 제거 + 마스터 칩 풀 중앙화.
//   새 칩 등록 시 적용할 카테고리들을 한 번에 선택 → field_keys 에 일괄 append.
// ──────────────────────────────────────────────────
function ChipRegisterModal({
  allTemplates, onClose, onSaved,
}: {
  allTemplates: Template[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [fieldName, setFieldName] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const existingPool = new Set(allTemplates.flatMap(t => t.field_keys));
  const activeTemplates = allTemplates.filter(t => t.is_active);

  function toggleCategory(id: string) {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id); else next.add(id);
    setSelected(next);
  }
  function selectAll() { setSelected(new Set(activeTemplates.map(t => t.id))); }
  function clearAll() { setSelected(new Set()); }

  async function handleSave() {
    setError("");
    const name = fieldName.trim();
    if (!name) { setError("필드명을 입력해주세요."); return; }
    if (selected.size === 0) { setError("적용할 카테고리를 1개 이상 선택해주세요."); return; }

    setSaving(true);
    // 선택 카테고리들의 field_keys 에 새 필드 append (중복 skip).
    // 마스터 풀에 이미 있어도 OK — 카테고리별로 활성/비활성은 별개.
    const updates = activeTemplates
      .filter(t => selected.has(t.id))
      .filter(t => !t.field_keys.includes(name))
      .map(t => ({
        id: t.id,
        field_keys: [...t.field_keys, name],
      }));

    let failed = 0;
    for (const u of updates) {
      const { error: err } = await supabase
        .from("measurement_templates")
        .update({ field_keys: u.field_keys, updated_at: new Date().toISOString() })
        .eq("id", u.id);
      if (err) failed++;
    }
    setSaving(false);
    if (failed > 0) { setError(`${updates.length}건 중 ${failed}건 저장 실패`); return; }
    onSaved();
  }

  return (
    <Modal size="2xl" onClose={onClose}>
      <div className="flex flex-col max-h-[85vh]">
        <div className="px-6 pt-6 pb-4 border-b border-gray-100">
          <h3 className="text-lg font-bold text-gray-900">새 측정 필드 (칩) 등록</h3>
          <p className="text-xs text-gray-500 mt-0.5">
            마스터 칩 풀에 추가 + 선택한 카테고리들에 일괄 적용. 박제 데이터에 영향 X.
          </p>
        </div>

        <div className="overflow-y-auto flex-1 px-6 py-5 space-y-4">
          <div>
            <label className="block text-xs text-gray-600 mb-1">필드명 *</label>
            <input type="text" value={fieldName} onChange={e => setFieldName(e.target.value)}
              placeholder="예: 어깨단면 (모든 카테고리에서 같은 이름으로 박제)"
              className={INPUT} autoFocus />
            {fieldName.trim() && existingPool.has(fieldName.trim()) && (
              <p className="text-[11px] text-amber-600 mt-1">
                ⚠️ 이미 마스터 풀에 있는 필드명입니다. 선택한 카테고리 중 아직 없는 곳에만 추가됩니다.
              </p>
            )}
          </div>

          <div>
            <div className="flex items-center justify-between mb-1.5">
              <label className="block text-xs text-gray-600">
                적용할 카테고리 — {selected.size} / {activeTemplates.length} 선택
              </label>
              <div className="flex gap-2 text-[11px]">
                <button onClick={selectAll} className="text-primary hover:underline">전체 선택</button>
                <button onClick={clearAll} className="text-gray-500 hover:underline">해제</button>
              </div>
            </div>
            <div className="border border-gray-200 rounded p-3 max-h-72 overflow-y-auto space-y-1">
              {activeTemplates.length === 0 ? (
                <p className="text-xs text-gray-400 text-center py-3">활성 카테고리 없음</p>
              ) : activeTemplates.map(t => {
                const alreadyHas = t.field_keys.includes(fieldName.trim());
                return (
                  <label key={t.id}
                    className={"flex items-center gap-2 px-2 py-1.5 rounded cursor-pointer hover:bg-gray-50 " +
                      (alreadyHas ? "opacity-50" : "")}>
                    <input type="checkbox"
                      checked={selected.has(t.id)}
                      onChange={() => toggleCategory(t.id)}
                      className="accent-primary" />
                    <span className="text-sm text-black flex-1">{t.category}</span>
                    {alreadyHas && (
                      <span className="text-[10px] text-gray-400">이미 있음</span>
                    )}
                  </label>
                );
              })}
            </div>
          </div>

          {error && (
            <p className="text-sm text-red-500 bg-red-50 border border-red-200 rounded p-2">{error}</p>
          )}
        </div>

        <div className="px-6 py-4 border-t border-gray-100 flex justify-end gap-2">
          <button onClick={onClose} disabled={saving} className={SECONDARY_BTN}>취소</button>
          <button onClick={handleSave} disabled={saving} className={PRIMARY_BTN}>
            {saving ? "저장 중..." : `등록 + ${selected.size}개 카테고리에 적용`}
          </button>
        </div>
      </div>
    </Modal>
  );
}
