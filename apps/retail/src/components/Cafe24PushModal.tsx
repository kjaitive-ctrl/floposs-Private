"use client";

import { useState } from "react";
import { styles } from "@/common/styles";

interface Props {
  selectedIds: string[];
  rows: { id: string; consumer_name: string; wholesale_name: string; image_count: number; cafe24_product_no?: number | null }[];
  onClose: () => void;
  onDone: (updatedMap: Map<string, number>) => void;
}

type PushResult = { id: string; ok: boolean; cafe24_product_no?: number; error?: string };

export default function Cafe24PushModal({ selectedIds, rows, onClose, onDone }: Props) {
  const [pushing, setPushing] = useState(false);
  const [results, setResults] = useState<PushResult[] | null>(null);
  const [updatedMap, setUpdatedMap] = useState<Map<string, number>>(new Map());

  const selected = rows.filter(r => selectedIds.includes(r.id));
  const noImage  = selected.filter(r => r.image_count === 0);
  const canPush  = selected.filter(r => r.image_count > 0);
  const updates  = canPush.filter(r => r.cafe24_product_no != null);
  const creates  = canPush.filter(r => r.cafe24_product_no == null);

  async function handlePush() {
    if (canPush.length === 0) return;
    setPushing(true);
    try {
      const res = await fetch("/api/cafe24/push", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ productIds: canPush.map(r => r.id) }),
      });
      const data = await res.json() as { results?: PushResult[]; error?: string };
      if (!res.ok || data.error) {
        alert(data.error ?? "전송 실패");
        setPushing(false);
        return;
      }
      setResults(data.results ?? []);

      // 성공한 항목의 cafe24_product_no 맵 저장 — 닫기 버튼에서 onDone 호출
      const map = new Map<string, number>();
      (data.results ?? []).forEach(r => {
        if (r.ok && r.cafe24_product_no) map.set(r.id, r.cafe24_product_no);
      });
      setUpdatedMap(map);
    } catch (e) {
      alert(String(e));
    }
    setPushing(false);
  }

  const successCount = results?.filter(r => r.ok).length ?? 0;
  const failCount    = results?.filter(r => !r.ok).length ?? 0;

  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
      <div className={`${styles.card} w-full max-w-lg max-h-[80vh] flex flex-col`}>
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-bold text-black">카페24 전송</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-black text-lg leading-none">×</button>
        </div>

        {!results ? (
          <>
            <div className="flex-1 overflow-y-auto space-y-3 mb-4">
              {/* 전송 대상 */}
              <div className="text-xs text-gray-700">
                선택 <span className="font-semibold text-black">{selected.length}개</span> 중
                전송 가능 <span className="font-semibold text-green-700">{canPush.length}개</span>
                {noImage.length > 0 && (
                  <span className="ml-1 text-orange-600">(이미지 없음 {noImage.length}개 제외)</span>
                )}
              </div>

              {canPush.length > 0 && (
                <div className="text-[11px] text-gray-500 space-y-0.5">
                  {creates.length > 0 && <div>· 신규 등록: {creates.length}개</div>}
                  {updates.length > 0 && <div>· 정보 업데이트: {updates.length}개</div>}
                </div>
              )}

              {/* 이미지 없는 상품 목록 */}
              {noImage.length > 0 && (
                <div className="bg-orange-50 border border-orange-200 rounded p-2">
                  <p className="text-[11px] font-semibold text-orange-700 mb-1">이미지 없음 — 전송 제외</p>
                  {noImage.map(r => (
                    <div key={r.id} className="text-[11px] text-orange-600 truncate">
                      {r.consumer_name || r.wholesale_name || r.id}
                    </div>
                  ))}
                </div>
              )}

              <div className="text-[11px] text-gray-400 bg-gray-50 rounded p-2">
                · 진열 상태: <span className="font-medium text-gray-600">미진열</span> (카페24에서 직접 진열 설정)<br />
                · 전송 후 카페24 상품 관리에서 확인하세요.
              </div>
            </div>

            <div className="flex gap-2 pt-2 border-t border-gray-100">
              <button onClick={onClose} className={`${styles.btnSmallGhost} flex-1`}>취소</button>
              <button
                onClick={handlePush}
                disabled={pushing || canPush.length === 0}
                className={`${styles.btnPrimary} flex-1 disabled:opacity-50`}
              >
                {pushing ? "전송 중…" : `카페24 전송 ${canPush.length}개`}
              </button>
            </div>
          </>
        ) : (
          <>
            <div className="flex-1 overflow-y-auto space-y-2 mb-4">
              <div className="text-xs font-semibold text-black mb-2">
                전송 완료: 성공 {successCount}개 / 실패 {failCount}개
              </div>
              {results.map(r => {
                const row = rows.find(p => p.id === r.id);
                return (
                  <div key={r.id}
                    className={`flex items-start gap-2 text-[11px] rounded px-2 py-1 ${r.ok ? "bg-green-50 text-green-700" : "bg-red-50 text-red-700"}`}>
                    <span>{r.ok ? "✓" : "✗"}</span>
                    <div className="flex-1 min-w-0">
                      <div className="truncate font-medium">
                        {row?.consumer_name || row?.wholesale_name || r.id}
                      </div>
                      {r.ok && r.cafe24_product_no && (
                        <div className="text-[10px] opacity-70">상품번호: {r.cafe24_product_no}</div>
                      )}
                      {!r.ok && r.error && (
                        <div className="text-[10px] break-all whitespace-pre-wrap select-all">{r.error}</div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
            <button onClick={() => onDone(updatedMap)} className={`${styles.btnPrimary} w-full`}>닫기</button>
          </>
        )}
      </div>
    </div>
  );
}
