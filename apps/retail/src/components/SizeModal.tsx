"use client";

import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import { styles } from "@/common/styles";

type Template = {
  id: string;
  tenant_id: string | null;
  category: string;
  field_keys: string[];
  sort_order: number;
};

type MeasurementRow = {
  id?: string;       // DB row id (있으면 update, 없으면 insert)
  size: string;
  values: Record<string, string>; // 측정항목 값 (input string)
};

type Props = {
  tenantId: string;
  productId: string;
  productName: string;
  initialSizes: string[];  // 옵션2(사이즈) 콤마 분리 값 (예: ["S","M","L"]). 초기 row 자동 생성.
  initialCategory: string | null;
  onClose: () => void;
  onSaved: () => void;
};

export default function SizeModal({
  tenantId, productId, productName, initialSizes, initialCategory, onClose, onSaved,
}: Props) {
  const [templates, setTemplates] = useState<Template[]>([]);
  const [category, setCategory] = useState<string>(initialCategory ?? "");
  const [rows, setRows] = useState<MeasurementRow[]>([]);
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(true);

  // 1) 카테고리 템플릿 로드 (시스템 공통 + 이 tenant)
  useEffect(() => {
    (async () => {
      const { data } = await supabase
        .from("measurement_templates")
        .select("id, tenant_id, category, field_keys, sort_order")
        .or(`tenant_id.is.null,tenant_id.eq.${tenantId}`)
        .eq("is_active", true)
        .order("sort_order", { ascending: true });
      setTemplates((data ?? []) as Template[]);
    })();
  }, [tenantId]);

  // 2) 이 product 의 기존 measurements 로드
  useEffect(() => {
    (async () => {
      const { data } = await supabase
        .from("product_measurements")
        .select("id, size, measurements")
        .eq("product_id", productId);

      const existing = (data ?? []) as Array<{ id: string; size: string; measurements: Record<string, string | number> }>;
      const existingMap = new Map(existing.map(r => [r.size, r]));

      // 옵션 사이즈 + 기존 박제 사이즈 합치기 (옵션 사이즈가 없는 박제는 그대로 유지)
      const seen = new Set<string>();
      const next: MeasurementRow[] = [];
      for (const s of initialSizes) {
        if (!s || seen.has(s)) continue;
        seen.add(s);
        const ex = existingMap.get(s);
        next.push({
          id: ex?.id,
          size: s,
          values: ex ? Object.fromEntries(Object.entries(ex.measurements).map(([k, v]) => [k, String(v)])) : {},
        });
      }
      // 기존 박제 중 옵션 사이즈에 없는 row 도 표시 (사장이 추가 박은 사이즈)
      for (const ex of existing) {
        if (seen.has(ex.size)) continue;
        seen.add(ex.size);
        next.push({
          id: ex.id,
          size: ex.size,
          values: Object.fromEntries(Object.entries(ex.measurements).map(([k, v]) => [k, String(v)])),
        });
      }
      setRows(next.length > 0 ? next : [{ size: "", values: {} }]);
      setLoading(false);
    })();
  }, [productId, initialSizes]);

  const currentTemplate = templates.find(t => t.category === category);
  const fieldKeys = currentTemplate?.field_keys ?? [];

  function updateSize(idx: number, value: string) {
    setRows(prev => prev.map((r, i) => i === idx ? { ...r, size: value } : r));
  }

  function updateValue(idx: number, field: string, value: string) {
    setRows(prev => prev.map((r, i) => i === idx ? { ...r, values: { ...r.values, [field]: value } } : r));
  }

  function addSize() {
    setRows(prev => [...prev, { size: "", values: {} }]);
  }

  function removeSize(idx: number) {
    setRows(prev => prev.filter((_, i) => i !== idx));
  }

  async function handleSave() {
    setSaving(true);

    // 카테고리 박제 (products.category)
    if (category) {
      await supabase.from("products")
        .update({ category, updated_at: new Date().toISOString() })
        .eq("id", productId);
    }

    // product_measurements upsert
    // 유효 row 만 (size 채워진 것)
    const validRows = rows.filter(r => r.size.trim());
    const upserts = validRows.map(r => ({
      product_id: productId,
      size: r.size.trim(),
      measurements: Object.fromEntries(
        Object.entries(r.values)
          .filter(([, v]) => v !== "" && v !== undefined)
          .map(([k, v]) => [k, Number(v) || v])
      ),
    }));

    if (upserts.length > 0) {
      const { error } = await supabase.from("product_measurements")
        .upsert(upserts, { onConflict: "product_id,size" });
      if (error) {
        alert(`사이즈표 저장 실패: ${error.message}`);
        setSaving(false);
        return;
      }
    }

    setSaving(false);
    onSaved();
  }

  return (
    <div className={styles.modalOverlay} onClick={onClose}>
      <div className={styles.modalContent} onClick={e => e.stopPropagation()}>

        {/* 헤더 */}
        <div className={styles.modalHeader}>
          <h3 className="text-lg font-bold text-black mb-1">사이즈/소재 정보</h3>
          <p className="text-xs text-gray-500">{productName}</p>
        </div>

        {/* 본문 */}
        <div className={styles.modalBody}>

          {/* 카테고리 선택 */}
          <div>
            <label className={styles.modalLabel}>카테고리 *</label>
            <select value={category} onChange={e => setCategory(e.target.value)}
              className={styles.modalInput}>
              <option value="">— 카테고리 선택 —</option>
              {templates.map(t => (
                <option key={t.id} value={t.category}>
                  {t.category} {t.tenant_id ? "(내 커스텀)" : ""}
                </option>
              ))}
            </select>
            <p className="text-xs text-gray-600 mt-1">
              카테고리 선택 시 측정항목이 자동 표시됩니다. 옵션(사이즈)과 매칭은 별개 — 자유롭게 박제.
            </p>
          </div>

          {/* 사이즈표 행렬 */}
          {loading ? (
            <p className="text-xs text-gray-400 text-center py-6">불러오는 중...</p>
          ) : !category ? (
            <p className="text-xs text-amber-600 text-center py-6">먼저 카테고리를 선택해주세요.</p>
          ) : fieldKeys.length === 0 ? (
            <p className="text-xs text-amber-600 text-center py-6">
              &quot;{category}&quot; 카테고리에 측정항목이 정의되지 않았습니다.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full border border-gray-300 text-xs">
                <thead className="bg-gray-100 border-b border-gray-300">
                  <tr>
                    <th className="px-3 py-2 text-left w-24 text-black font-medium">사이즈</th>
                    {fieldKeys.map(f => (
                      <th key={f} className="px-3 py-2 text-center text-black font-medium">{f}</th>
                    ))}
                    <th className="px-2 py-2 w-10"></th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r, idx) => (
                    <tr key={idx} className="border-t border-gray-200">
                      <td className="px-2 py-1">
                        <input value={r.size}
                          onChange={e => updateSize(idx, e.target.value)}
                          placeholder="FREE"
                          className="w-full px-2 py-1 border border-gray-300 rounded text-xs text-black placeholder:text-gray-500" />
                      </td>
                      {fieldKeys.map(f => (
                        <td key={f} className="px-2 py-1">
                          <input type="number" inputMode="decimal" min={0}
                            value={r.values[f] ?? ""}
                            onChange={e => {
                              const v = e.target.value;
                              // 음수 paste 차단 (browser min 만으론 paste 못 막음)
                              if (v && Number(v) < 0) return;
                              updateValue(idx, f, v);
                            }}
                            onKeyDown={e => {
                              // "-" / "e" 키 차단 (음수 / 지수 표기 우회)
                              if (e.key === "-" || e.key === "e") e.preventDefault();
                            }}
                            className="w-full px-2 py-1 border border-gray-300 rounded text-xs text-center text-black" />
                        </td>
                      ))}
                      <td className="px-2 py-1 text-center">
                        <button onClick={() => removeSize(idx)}
                          className="text-red-500 hover:text-red-700 text-sm leading-none">×</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <button onClick={addSize}
                className="mt-2 text-xs px-3 py-1 border border-gray-400 text-black rounded hover:bg-gray-50">
                + 사이즈 추가
              </button>
            </div>
          )}
        </div>

        {/* 푸터 */}
        <div className={styles.modalFooter}>
          <button onClick={onClose} className={`${styles.btnSecondary} flex-1 py-2.5`}>
            닫기
          </button>
          <button onClick={handleSave} disabled={saving || !category}
            className={`${styles.btnPrimary} flex-1 py-2.5`}>
            {saving ? "저장 중..." : "저장"}
          </button>
        </div>
      </div>
    </div>
  );
}
