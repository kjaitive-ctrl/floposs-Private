"use client";

import { useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";

// 전자노트 공개 보드 (안건3 받는쪽 v1). 로그인 없이 도매가 자기 slot 주문을 봄.
// 날짜 그룹 + 접기/펼치기 + "더 보기" 페이지네이션 (주문 폭증 대비). 읽기 전용.
// 클레임/처리/프라이버시 게이트 = 다음 단계.
interface BoardItem {
  supplier_product_name: string | null;
  consumer_product_name: string | null;
  supplier_option_label: string | null;
  consumer_option_label: string | null;
  quantity: number;
  unit_price: number;
  variant_barcode: string | null;
}
interface BoardNote {
  id: string;
  sent_at: string;
  is_test: boolean;
  sender: { company_name: string | null } | { company_name: string | null }[] | null;
  items: BoardItem[];
}

export default function NoteBoardPage() {
  const params = useParams<{ code: string }>();
  const code = params.code;

  const [head, setHead] = useState<{ store_name: string; loc: string } | null>(null);
  const [notes, setNotes] = useState<BoardNote[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [notFound, setNotFound] = useState(false);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  const fetchPage = useCallback(async (before?: string) => {
    const url = before
      ? `/api/note-board/${code}?before=${encodeURIComponent(before)}`
      : `/api/note-board/${code}`;
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) return null;
    return res.json() as Promise<{ store_name: string; loc: string; notes: BoardNote[]; hasMore: boolean }>;
  }, [code]);

  useEffect(() => {
    if (!code) return;
    let cancelled = false;
    (async () => {
      setLoading(true);
      const data = await fetchPage();
      if (cancelled) return;
      if (!data) { setNotFound(true); setLoading(false); return; }
      setHead({ store_name: data.store_name, loc: data.loc });
      setNotes(data.notes);
      setHasMore(data.hasMore);
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [code, fetchPage]);

  async function loadMore() {
    if (loadingMore || notes.length === 0) return;
    setLoadingMore(true);
    const last = notes[notes.length - 1];
    const data = await fetchPage(last.sent_at);
    if (data) {
      setNotes(prev => [...prev, ...data.notes]);
      setHasMore(data.hasMore);
    }
    setLoadingMore(false);
  }

  function toggle(date: string) {
    setCollapsed(prev => {
      const n = new Set(prev);
      if (n.has(date)) n.delete(date); else n.add(date);
      return n;
    });
  }

  const senderName = (n: BoardNote) => {
    const s = Array.isArray(n.sender) ? n.sender[0] : n.sender;
    return s?.company_name ?? "소매";
  };
  const dateOf = (s: string) => s.slice(0, 10);
  const timeOf = (s: string) => s.slice(11, 16);

  // 날짜별 그룹 (notes 는 이미 최신순)
  const groups: { date: string; notes: BoardNote[] }[] = [];
  for (const n of notes) {
    const d = dateOf(n.sent_at);
    const last = groups[groups.length - 1];
    if (last && last.date === d) last.notes.push(n);
    else groups.push({ date: d, notes: [n] });
  }

  return (
    <main className="min-h-screen bg-gray-50 px-4 py-6">
      <div className="max-w-2xl mx-auto">
        {loading ? (
          <div className="text-center text-sm text-gray-400 py-20">불러오는 중…</div>
        ) : notFound || !head ? (
          <div className="text-center text-sm text-gray-500 py-20">존재하지 않는 주소입니다.</div>
        ) : (
          <>
            <div className="bg-white rounded-2xl border border-gray-200 px-5 py-4 mb-4">
              <div className="text-[11px] text-gray-400 mb-0.5">전자노트 · 들어온 주문</div>
              <h1 className="text-xl font-bold text-black">
                {head.store_name}
                {head.loc && <span className="text-gray-400 font-normal text-base"> · {head.loc}</span>}
              </h1>
              <p className="text-xs text-gray-500 mt-1">소매들이 보낸 주문이 이 자리로 모입니다. (읽기 전용)</p>
            </div>

            {notes.length === 0 ? (
              <div className="text-center text-sm text-gray-400 bg-white rounded-2xl border border-gray-200 py-16">
                아직 들어온 주문이 없습니다.
              </div>
            ) : (
              <div className="space-y-4">
                {groups.map(g => {
                  const isCol = collapsed.has(g.date);
                  return (
                    <div key={g.date}>
                      <button
                        type="button"
                        onClick={() => toggle(g.date)}
                        className="w-full flex items-center gap-2 text-xs font-semibold text-gray-500 mb-1.5 hover:text-black"
                      >
                        <span>{isCol ? "▸" : "▾"}</span>
                        <span>{g.date}</span>
                        <span className="text-gray-300 font-normal">· {g.notes.length}건</span>
                      </button>
                      {!isCol && (
                        <ul className="space-y-2">
                          {g.notes.map(n => (
                            <li key={n.id} className="bg-white rounded-xl border border-gray-200 overflow-hidden">
                              <div className="px-3 py-1.5 bg-gray-50 border-b border-gray-100 flex items-center gap-2">
                                <span className="font-semibold text-black text-xs">{senderName(n)}</span>
                                {n.is_test && <span className="text-[10px] text-amber-700 bg-amber-50 border border-amber-200 rounded px-1">테스트</span>}
                                <span className="ml-auto text-[11px] text-gray-400">{timeOf(n.sent_at)}</span>
                              </div>
                              <table className="w-full text-xs">
                                <tbody>
                                  {n.items.map((it, i) => (
                                    <tr key={i} className="border-t border-gray-50">
                                      <td className="px-3 py-1 text-black">{it.supplier_product_name || it.consumer_product_name || "(상품)"}</td>
                                      <td className="px-2 py-1 text-gray-500 whitespace-nowrap">{it.supplier_option_label || it.consumer_option_label || "-"}</td>
                                      <td className="px-2 py-1 text-right text-black font-medium whitespace-nowrap">{it.quantity}개</td>
                                      <td className="px-3 py-1 text-right text-gray-500 whitespace-nowrap">{it.unit_price > 0 ? `${Number(it.unit_price).toLocaleString()}원` : "-"}</td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  );
                })}

                {hasMore && (
                  <button
                    type="button"
                    onClick={loadMore}
                    disabled={loadingMore}
                    className="w-full py-2.5 text-xs text-gray-600 bg-white border border-gray-200 rounded-xl hover:bg-gray-50 disabled:opacity-50"
                  >
                    {loadingMore ? "불러오는 중…" : "더 보기"}
                  </button>
                )}
              </div>
            )}

            <p className="text-center text-[11px] text-gray-300 mt-6">floposs 전자노트</p>
          </>
        )}
      </div>
    </main>
  );
}
