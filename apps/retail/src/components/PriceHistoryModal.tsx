"use client";

// 상품 가격 변경 이력 조회 (안건3, 마이그 207). 날짜 / 항목 / old→new / 아이디.
import { useEffect, useState } from "react";
import { styles } from "@/common/styles";
import { supabase } from "@/lib/supabase";

const FIELD_LABEL: Record<string, string> = {
  wholesale_price_current: "공급가",
  regular_sale_price: "상시판매가",
  sale_price: "판매가",
  consumer_price: "소비자가",
};

interface Row {
  id: string;
  field: string;
  old_value: number | null;
  new_value: number | null;
  changed_by_user_id: string | null;
  changed_at: string;
}

export default function PriceHistoryModal({
  productId, productName, onClose,
}: {
  productId: string;
  productName: string;
  onClose: () => void;
}) {
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data } = await supabase.from("product_price_history")
        .select("id, field, old_value, new_value, changed_by_user_id, changed_at")
        .eq("product_id", productId)
        .order("changed_at", { ascending: false })
        .limit(200);
      if (!cancelled) { setRows((data ?? []) as Row[]); setLoading(false); }
    })();
    return () => { cancelled = true; };
  }, [productId]);

  const fmt = (n: number | null) => (n == null ? "-" : Number(n).toLocaleString());
  const dt = (s: string) => s.slice(0, 16).replace("T", " ");

  return (
    <div className={styles.modalOverlay} onMouseDown={onClose}>
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-md flex flex-col max-h-[80vh]" onMouseDown={e => e.stopPropagation()}>
        <div className="px-5 pt-5 pb-3 border-b border-gray-100">
          <h3 className="text-base font-bold text-black">가격 변경 이력</h3>
          <p className="text-xs text-gray-500 mt-0.5 truncate">{productName}</p>
        </div>
        <div className="overflow-y-auto flex-1 px-3 py-2">
          {loading ? (
            <div className="text-xs text-gray-400 p-6 text-center">불러오는 중…</div>
          ) : rows.length === 0 ? (
            <div className="text-xs text-gray-400 p-6 text-center">변경 이력이 없습니다.</div>
          ) : (
            <table className="w-full text-xs">
              <thead>
                <tr className="text-gray-400 text-left">
                  <th className="px-2 py-1 font-medium">날짜</th>
                  <th className="px-2 py-1 font-medium">항목</th>
                  <th className="px-2 py-1 font-medium text-right">변경</th>
                  <th className="px-2 py-1 font-medium">아이디</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(r => (
                  <tr key={r.id} className="border-t border-gray-50">
                    <td className="px-2 py-1.5 text-gray-500 whitespace-nowrap">{dt(r.changed_at)}</td>
                    <td className="px-2 py-1.5 text-black">{FIELD_LABEL[r.field] ?? r.field}</td>
                    <td className="px-2 py-1.5 text-right whitespace-nowrap">
                      <span className="text-gray-400">{fmt(r.old_value)}</span>
                      <span className="text-gray-300"> → </span>
                      <span className="text-black font-medium">{fmt(r.new_value)}</span>
                    </td>
                    <td className="px-2 py-1.5 text-gray-400 font-mono">{r.changed_by_user_id ? r.changed_by_user_id.slice(0, 8) : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
        <div className="px-5 pb-5 pt-3 border-t border-gray-100 flex justify-end">
          <button onClick={onClose} className={styles.btnSecondary}>닫기</button>
        </div>
      </div>
    </div>
  );
}
