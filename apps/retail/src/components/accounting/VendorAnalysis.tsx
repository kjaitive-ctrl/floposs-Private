"use client";

// 거래처별 지출분석 — 출금 거래를 거래처로 묶어 랭킹. 엑셀에선 거래처가 컬럼이라
// 늘어나면 공간이 낭비됐던 부분 — 여기선 그냥 행이 느는 집계라 거래처 수와 무관.
import { useEffect, useState } from "react";
import { styles } from "@/common/styles";
import { formatComma } from "@/lib/format";
import { loadCashTransactions } from "@/lib/accounting";

interface VendorAgg { name: string; total: number; count: number; byCategory: Map<string, number> }

function monthRange(anchor: Date): { fromIso: string; toIso: string; label: string } {
  const y = anchor.getFullYear(), m = anchor.getMonth();
  const from = new Date(y, m, 1), to = new Date(y, m + 1, 0);
  const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  return { fromIso: iso(from), toIso: iso(to), label: `${y}년 ${m + 1}월` };
}

export default function VendorAnalysis({ tenantId }: { tenantId: string }) {
  const [anchor, setAnchor] = useState(() => new Date());
  const { fromIso, toIso, label } = monthRange(anchor);
  const [vendors, setVendors] = useState<VendorAgg[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    (async () => {
      const txns = await loadCashTransactions(tenantId, fromIso, toIso);
      const map = new Map<string, VendorAgg>();
      for (const t of txns) {
        if (t.direction !== "out") continue;
        const name = t.counterparty_name?.trim() || "(거래처 미입력)";
        const agg = map.get(name) ?? { name, total: 0, count: 0, byCategory: new Map<string, number>() };
        agg.total += t.amount;
        agg.count += 1;
        const catName = t.category?.name ?? "미분류";
        agg.byCategory.set(catName, (agg.byCategory.get(catName) ?? 0) + t.amount);
        map.set(name, agg);
      }
      if (cancelled) return;
      setVendors(Array.from(map.values()).sort((a, b) => b.total - a.total));
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [tenantId, fromIso, toIso]);

  const grandTotal = vendors.reduce((s, v) => s + v.total, 0);

  return (
    <div>
      <div className="flex items-center gap-3 mb-4">
        <button type="button" className={styles.btnSmallGhost} onClick={() => setAnchor(a => new Date(a.getFullYear(), a.getMonth() - 1, 1))}>‹</button>
        <div className="text-sm font-bold text-black w-24 text-center">{label}</div>
        <button type="button" className={styles.btnSmallGhost} onClick={() => setAnchor(a => new Date(a.getFullYear(), a.getMonth() + 1, 1))}>›</button>
        <div className="ml-auto text-xs text-gray-500">출금 총액 <b className="text-black">{formatComma(grandTotal)}</b></div>
      </div>

      {loading ? (
        <div className="text-xs text-gray-400">불러오는 중…</div>
      ) : vendors.length === 0 ? (
        <div className="text-xs text-gray-400">이 달 출금 거래가 없어요.</div>
      ) : (
        <div className="space-y-2">
          {vendors.map(v => (
            <div key={v.name} className={styles.cardSm}>
              <div className="flex items-center justify-between">
                <div className="text-sm font-medium text-black">{v.name}</div>
                <div className="text-right">
                  <div className="text-sm font-bold text-black">{formatComma(v.total)}</div>
                  <div className="text-[11px] text-gray-400">{v.count}건 · {grandTotal > 0 ? Math.round((v.total / grandTotal) * 100) : 0}%</div>
                </div>
              </div>
              {v.byCategory.size > 1 && (
                <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 border-t border-gray-100 pt-1.5">
                  {Array.from(v.byCategory.entries()).sort((a, b) => b[1] - a[1]).map(([cat, sum]) => (
                    <span key={cat} className="text-[11px] text-gray-500">{cat} {formatComma(sum)}</span>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
