"use client";

// 월별 손익 리포트 — cash_transactions 를 계정과목 성격(type)별로 자동 집계.
// 부가세는 제외(공급가액 기준)하고, 자본거래(대납/가지급금 등)는 손익에서 뺀다.
import { useEffect, useState } from "react";
import { styles } from "@/common/styles";
import { formatComma } from "@/lib/format";
import { PNL_TYPES, type AccountType, loadCashTransactions } from "@/lib/accounting";

interface CategoryAgg { name: string; total: number }
interface TypeAgg { type: AccountType; total: number; byCategory: CategoryAgg[] }

function monthRange(anchor: Date): { fromIso: string; toIso: string; label: string } {
  const y = anchor.getFullYear(), m = anchor.getMonth();
  const from = new Date(y, m, 1), to = new Date(y, m + 1, 0);
  const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  return { fromIso: iso(from), toIso: iso(to), label: `${y}년 ${m + 1}월` };
}

async function aggregate(tenantId: string, fromIso: string, toIso: string): Promise<Map<AccountType, TypeAgg>> {
  const txns = await loadCashTransactions(tenantId, fromIso, toIso);
  const map = new Map<AccountType, TypeAgg>();
  for (const t of PNL_TYPES) map.set(t, { type: t, total: 0, byCategory: [] });
  for (const t of txns) {
    if (!t.category || !PNL_TYPES.includes(t.category.type)) continue;
    const agg = map.get(t.category.type)!;
    agg.total += t.supply_amount;
    const cat = agg.byCategory.find(c => c.name === t.category!.name);
    if (cat) cat.total += t.supply_amount;
    else agg.byCategory.push({ name: t.category.name, total: t.supply_amount });
  }
  for (const agg of map.values()) agg.byCategory.sort((a, b) => b.total - a.total);
  return map;
}

export default function PnlReport({ tenantId }: { tenantId: string }) {
  const [anchor, setAnchor] = useState(() => new Date());
  const { fromIso, toIso, label } = monthRange(anchor);
  const [current, setCurrent] = useState<Map<AccountType, TypeAgg> | null>(null);
  const [prevTotal, setPrevTotal] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);

  function pnl(map: Map<AccountType, TypeAgg>): number {
    const rev = map.get("매출")?.total ?? 0;
    const cost = map.get("매입원가")?.total ?? 0;
    const labor = map.get("인건비")?.total ?? 0;
    const sga = map.get("판관비")?.total ?? 0;
    const tax = map.get("세금과공과")?.total ?? 0;
    return rev - cost - labor - sga - tax;
  }

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    (async () => {
      const cur = await aggregate(tenantId, fromIso, toIso);
      const prevAnchor = new Date(anchor.getFullYear(), anchor.getMonth() - 1, 1);
      const prevRange = monthRange(prevAnchor);
      const prev = await aggregate(tenantId, prevRange.fromIso, prevRange.toIso);
      if (cancelled) return;
      setCurrent(cur);
      setPrevTotal(pnl(prev));
      setLoading(false);
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tenantId, fromIso, toIso]);

  const rev = current?.get("매출")?.total ?? 0;
  const cost = current?.get("매입원가")?.total ?? 0;
  const grossProfit = rev - cost;
  const labor = current?.get("인건비")?.total ?? 0;
  const sga = current?.get("판관비")?.total ?? 0;
  const tax = current?.get("세금과공과")?.total ?? 0;
  const netProfit = grossProfit - labor - sga - tax;
  const delta = prevTotal === null ? null : netProfit - prevTotal;

  return (
    <div>
      <div className="flex items-center gap-3 mb-4">
        <button type="button" className={styles.btnSmallGhost} onClick={() => setAnchor(a => new Date(a.getFullYear(), a.getMonth() - 1, 1))}>‹</button>
        <div className="text-sm font-bold text-black w-24 text-center">{label}</div>
        <button type="button" className={styles.btnSmallGhost} onClick={() => setAnchor(a => new Date(a.getFullYear(), a.getMonth() + 1, 1))}>›</button>
      </div>

      {loading ? (
        <div className="text-xs text-gray-400">불러오는 중…</div>
      ) : (
        <div className="space-y-3">
          <div className={styles.card}>
            <div className="flex items-baseline justify-between">
              <div className={styles.sectionLabel}>순손익 (공급가 기준, 부가세 제외)</div>
              {delta !== null && (
                <div className={"text-xs " + (delta >= 0 ? "text-green-600" : "text-red-600")}>
                  전월 대비 {delta >= 0 ? "+" : ""}{formatComma(delta)}
                </div>
              )}
            </div>
            <div className={"text-3xl font-bold " + (netProfit >= 0 ? "text-black" : "text-red-600")}>{formatComma(netProfit)}원</div>
          </div>

          <PnlLine label="매출" value={rev} />
          <PnlLine label="매입원가" value={-cost} categories={current?.get("매입원가")?.byCategory} />
          <PnlLine label="= 매출총이익" value={grossProfit} strong />
          <PnlLine label="인건비" value={-labor} categories={current?.get("인건비")?.byCategory} />
          <PnlLine label="판관비" value={-sga} categories={current?.get("판관비")?.byCategory} />
          <PnlLine label="세금과공과" value={-tax} categories={current?.get("세금과공과")?.byCategory} />
          <PnlLine label="= 순손익" value={netProfit} strong />
        </div>
      )}
    </div>
  );
}

function PnlLine({ label, value, categories, strong }: { label: string; value: number; categories?: CategoryAgg[]; strong?: boolean }) {
  return (
    <div className={styles.cardSm}>
      <div className="flex items-center justify-between">
        <div className={strong ? "text-sm font-bold text-black" : "text-xs font-medium text-gray-600"}>{label}</div>
        <div className={(strong ? "text-sm font-bold " : "text-xs font-medium ") + (value < 0 ? "text-red-600" : "text-black")}>
          {value < 0 ? "-" : ""}{formatComma(Math.abs(value))}
        </div>
      </div>
      {categories && categories.length > 0 && (
        <div className="mt-2 space-y-1 border-t border-gray-100 pt-2">
          {categories.map(c => (
            <div key={c.name} className="flex items-center justify-between text-[11px] text-gray-500">
              <span>{c.name}</span>
              <span>{formatComma(c.total)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
