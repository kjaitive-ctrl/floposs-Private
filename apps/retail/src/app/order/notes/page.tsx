"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { styles } from "@/common/styles";
import { useTenant } from "@/lib/TenantContext";
import { loadMyOrderNotes, type OrderNote } from "@/lib/orderNotes";

// 발신 주문내역 (안건3 C4 Phase C). 내가 보낸 노트 — 최신순, 클릭 시 상세.
// 날짜 헤더로 그룹. retail 은 자기 발신만 본다.
export default function OrderNotesPage() {
  const { tenant } = useTenant();
  const [notes, setNotes] = useState<OrderNote[]>([]);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState<Set<string>>(new Set());

  const reload = useCallback(async () => {
    if (!tenant?.id) return;
    setLoading(true);
    setNotes(await loadMyOrderNotes(tenant.id));
    setLoading(false);
  }, [tenant?.id]);

  useEffect(() => { reload(); }, [reload]);

  function toggle(id: string) {
    setOpen(prev => {
      const n = new Set(prev);
      if (n.has(id)) n.delete(id); else n.add(id);
      return n;
    });
  }

  const fmtDate = (s: string) => s.slice(0, 10);
  const fmtTime = (s: string) => {
    const d = s.slice(11, 16);
    return d || "";
  };

  // 날짜별 그룹
  const groups: { date: string; notes: OrderNote[] }[] = [];
  for (const n of notes) {
    const d = fmtDate(n.sent_at);
    const last = groups[groups.length - 1];
    if (last && last.date === d) last.notes.push(n);
    else groups.push({ date: d, notes: [n] });
  }

  return (
    <main className={styles.main}>
      <div className="flex items-center gap-3 mb-4">
        <Link href="/order/browse" className="text-xs text-gray-500 hover:text-black">← 거래처 선택</Link>
      </div>

      <h1 className="text-xl font-bold text-black mb-1">내 주문내역</h1>
      <p className="text-xs text-gray-500 mb-4">보낸 발주를 날짜별로 모았습니다. 줄을 누르면 상세가 펼쳐져요.</p>

      {loading ? (
        <div className="text-xs text-gray-400">불러오는 중…</div>
      ) : notes.length === 0 ? (
        <div className="text-sm text-gray-500 bg-gray-50 border border-gray-200 rounded-xl px-4 py-6 text-center">
          아직 보낸 주문이 없습니다.{" "}
          <Link href="/order/browse" className="text-primary hover:underline font-medium">거래처 선택</Link>에서 발주를 보내보세요.
        </div>
      ) : (
        <div className="space-y-4">
          {groups.map(g => (
            <div key={g.date}>
              <div className="text-xs font-semibold text-gray-400 mb-1.5">{g.date}</div>
              <ul className="space-y-2">
                {g.notes.map(n => {
                  const isOpen = open.has(n.id);
                  return (
                    <li key={n.id} className="bg-white border border-gray-200 rounded-xl overflow-hidden">
                      <button
                        type="button"
                        onClick={() => toggle(n.id)}
                        className="w-full text-left px-4 py-3 hover:bg-gray-50 flex items-center gap-2"
                      >
                        <div className="min-w-0 flex-1">
                          <div className="font-medium text-black truncate">
                            {n.store_name}
                            {n.loc && <span className="text-gray-400 font-normal"> · {n.loc}</span>}
                            {n.pickup_status === "picked" && <span className="ml-2 text-[10px] text-emerald-700 bg-emerald-50 border border-emerald-200 rounded px-1">픽업완료</span>}
                            {n.pickup_status === "failed" && <span className="ml-2 text-[10px] text-red-700 bg-red-50 border border-red-200 rounded px-1">픽업실패</span>}
                            {n.is_test && <span className="ml-2 text-[10px] text-amber-700 bg-amber-50 border border-amber-200 rounded px-1">테스트</span>}
                          </div>
                          <div className="text-xs text-gray-500 mt-0.5">
                            {fmtTime(n.sent_at)} · {n.total_qty}개
                            {n.total_amount > 0 && <> · {n.total_amount.toLocaleString()}원</>}
                          </div>
                        </div>
                        <span className="text-gray-400 text-xs shrink-0">{isOpen ? "▲" : "▼"}</span>
                      </button>
                      {isOpen && (
                        <div className="border-t border-gray-100 px-4 py-2">
                          <table className="w-full text-xs">
                            <thead>
                              <tr className="text-gray-400 text-left">
                                <th className="py-1 font-medium">내 상품 / 공급사 상품</th>
                                <th className="py-1 font-medium">옵션</th>
                                <th className="py-1 font-medium text-right">수량</th>
                                <th className="py-1 font-medium text-right">단가</th>
                                <th className="py-1 font-medium text-center">출고(도매)</th>
                              </tr>
                            </thead>
                            <tbody>
                              {n.items.map((it, i) => (
                                <tr key={i} className="border-t border-gray-50">
                                  <td className="py-1.5">
                                    <div className="text-black">{it.consumer_product_name || <span className="text-gray-300">미입력</span>}</div>
                                    <div className="text-[11px] text-gray-400">{it.supplier_product_name}</div>
                                  </td>
                                  <td className="py-1.5 text-gray-600">
                                    {it.consumer_option_label || it.supplier_option_label || "-"}
                                  </td>
                                  <td className="py-1.5 text-right text-black">{it.quantity}</td>
                                  <td className="py-1.5 text-right text-gray-600">
                                    {it.unit_price > 0 ? Number(it.unit_price).toLocaleString() : "-"}
                                  </td>
                                  <td className="py-1.5 text-center">
                                    {it.shipped_quantity != null
                                      ? <span className={it.shipped_quantity < it.quantity ? "text-amber-600 font-medium" : "text-emerald-600 font-medium"}>{it.shipped_quantity}</span>
                                      : <span className="text-gray-300">대기</span>}
                                    {it.ship_memo && <div className="text-[11px] text-amber-600">{it.ship_memo}</div>}
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </div>
      )}
    </main>
  );
}
