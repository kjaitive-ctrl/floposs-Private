"use client";

// 도매가 통제형 편집 (안건3). 자유 텍스트 대신 원본표시 + 빠른 +/- + 원래대로 + 저장확인.
// 원본 wholesale_price 는 불변, 현재가(wholesale_price_current)만 변경. 원래대로=null(원본 사용).
// 저장 시 207 트리거가 변경 이력 자동 박제.
import { useState } from "react";
import { styles } from "@/common/styles";
import { supabase } from "@/lib/supabase";

const STEPS = [-1000, -500, -100, 100, 500, 1000];

export default function PriceModal({
  productId, productName, originalPrice, currentPrice, onClose, onSaved,
}: {
  productId: string;
  productName: string;
  originalPrice: number | null;
  currentPrice: number | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const base = originalPrice ?? 0;
  const [value, setValue] = useState<number>(currentPrice ?? base);
  const [saving, setSaving] = useState(false);

  const fmt = (n: number) => n.toLocaleString();
  const bump = (d: number) => setValue(v => Math.max(0, v + d));

  async function save() {
    const toStore = value === base ? null : value;  // 원본과 같으면 해제(원본 사용)
    const ok = window.confirm(
      `도매가 변경\n\n원본 ${fmt(base)}원 → 현재 ${toStore == null ? "원본 사용" : fmt(value) + "원"}\n\n저장할까요?`
    );
    if (!ok) return;
    setSaving(true);
    const { error } = await supabase.from("products")
      .update({ wholesale_price_current: toStore, updated_at: new Date().toISOString() })
      .eq("id", productId);
    setSaving(false);
    if (error) { alert("저장 실패: " + error.message); return; }
    onSaved();
  }

  return (
    <div className={styles.modalOverlay} onMouseDown={onClose}>
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-sm" onMouseDown={e => e.stopPropagation()}>
        <div className="px-5 pt-5 pb-3 border-b border-gray-100">
          <h3 className="text-base font-bold text-black">도매가 수정</h3>
          <p className="text-xs text-gray-500 mt-0.5 truncate">{productName}</p>
        </div>

        <div className="px-5 py-4 space-y-3">
          <div className="flex items-center justify-between text-sm">
            <span className="text-gray-500">원본 도매가</span>
            <span className="text-gray-700">{originalPrice != null ? `${fmt(base)}원` : "-"}</span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-sm text-gray-500">현재 적용가</span>
            <span className="text-2xl font-bold text-black">
              {fmt(value)}<span className="text-sm font-normal text-gray-500">원</span>
            </span>
          </div>

          <div className="grid grid-cols-3 gap-1.5">
            {STEPS.map(s => (
              <button key={s} type="button" onClick={() => bump(s)}
                className={`py-1.5 text-xs rounded border ${s < 0 ? "border-blue-200 text-blue-700 hover:bg-blue-50" : "border-rose-200 text-rose-700 hover:bg-rose-50"}`}>
                {s > 0 ? `+${fmt(s)}` : fmt(s)}
              </button>
            ))}
          </div>

          {value !== base && (
            <button type="button" onClick={() => setValue(base)}
              className="w-full py-1.5 text-xs text-gray-600 border border-gray-200 rounded hover:bg-gray-50">
              ↺ 원래대로 ({fmt(base)}원)
            </button>
          )}
        </div>

        <div className="px-5 pb-5 pt-3 border-t border-gray-100 flex gap-2 justify-end">
          <button onClick={onClose} disabled={saving} className={styles.btnSecondary}>취소</button>
          <button onClick={save} disabled={saving} className={styles.btnPrimary}>{saving ? "저장 중…" : "저장"}</button>
        </div>
      </div>
    </div>
  );
}
