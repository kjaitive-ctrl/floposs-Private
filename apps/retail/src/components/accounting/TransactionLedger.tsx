"use client";

// 거래입력 — 일자순 리스트(엑셀의 유일한 장점: 세로 한 줄 스캔 유지) + 인라인 자동저장.
// 계정과목/거래처는 tenant 가 관리하는 마스터를 그 자리에서 골라 태깅.
import { useCallback, useEffect, useRef, useState } from "react";
import { styles } from "@/common/styles";
import { formatComma, parseDigits } from "@/lib/format";
import { useRowAutosave } from "@/lib/useRowAutosave";
import SaveStatusDot from "@/components/SaveStatusDot";
import { searchSlotStores, ensureRetailSupplier, type SlotStoreHit } from "@/lib/retailSuppliers";
import {
  type AccountCategory, type CashTransaction, type CashTransactionInput,
  loadAccountCategories, loadCashTransactions, addCashTransaction, updateCashTransaction, deleteCashTransaction,
  splitVat,
} from "@/lib/accounting";

type Row = CashTransactionInput & { id: string | null; _key: string; supply_amount: number; vat_amount: number };

function todayIso(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Seoul" });
}
function monthRange(anchor: Date): { fromIso: string; toIso: string; label: string } {
  const y = anchor.getFullYear(), m = anchor.getMonth();
  const from = new Date(y, m, 1), to = new Date(y, m + 1, 0);
  const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  return { fromIso: iso(from), toIso: iso(to), label: `${y}년 ${m + 1}월` };
}
function toRow(t: CashTransaction): Row {
  return {
    id: t.id, _key: t.id,
    txn_date: t.txn_date, direction: t.direction,
    account_category_id: t.account_category_id, retail_supplier_id: t.retail_supplier_id,
    counterparty_name: t.counterparty_name, amount: t.amount, vat_included: t.vat_included,
    memo: t.memo, supply_amount: t.supply_amount, vat_amount: t.vat_amount,
  };
}
function blankRow(dateIso: string): Row {
  return {
    id: null, _key: `draft-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    txn_date: dateIso, direction: "out", account_category_id: null, retail_supplier_id: null,
    counterparty_name: "", amount: 0, vat_included: false, memo: null,
    supply_amount: 0, vat_amount: 0,
  };
}

// 거래처 입력 — 타이핑 = 자유텍스트, 매칭되면 slot 거래처 링크(선택 사항).
// /samples 의 SupplierAutocomplete 와 달리 "미연결" 경고 없음 — 직원/임대인/국세청처럼
// slot 이 없는 수취인이 정상 케이스라 경고를 띄우면 오해를 줌.
function CounterpartyCell({ tenantId, value, onPick }: {
  tenantId: string; value: string; onPick: (name: string, supplierId: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const [hits, setHits] = useState<SlotStoreHit[]>([]);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  function handleInput(text: string) {
    onPick(text, null);
    if (timer.current) clearTimeout(timer.current);
    const t = text.trim();
    if (!t) { setHits([]); setOpen(false); return; }
    timer.current = setTimeout(async () => {
      setHits(await searchSlotStores(t));
      setOpen(true);
    }, 250);
  }

  async function choose(hit: SlotStoreHit) {
    setOpen(false);
    const sid = await ensureRetailSupplier(tenantId, hit.slot.id, hit.id);
    onPick(hit.store_name, sid);
  }

  return (
    <div className="relative w-full">
      <input
        value={value}
        placeholder="거래처/수취인"
        onChange={e => handleInput(e.target.value)}
        onFocus={() => { if (value.trim()) setOpen(true); }}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        className={styles.gridInput}
      />
      {open && hits.length > 0 && (
        <div className="absolute left-0 top-full z-30 mt-0.5 w-56 bg-white border border-gray-300 rounded-lg shadow-lg max-h-56 overflow-auto text-xs">
          {hits.map(h => (
            <button key={h.id} type="button" onMouseDown={e => { e.preventDefault(); choose(h); }}
              className="w-full text-left px-3 py-1.5 border-b border-gray-100 hover:bg-gray-50">
              <div className="font-medium text-black">{h.store_name}</div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export default function TransactionLedger({ tenantId }: { tenantId: string }) {
  const [anchor, setAnchor] = useState(() => new Date());
  const { fromIso, toIso, label } = monthRange(anchor);
  const [categories, setCategories] = useState<AccountCategory[]>([]);
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const rowsRef = useRef<Row[]>([]);
  useEffect(() => { rowsRef.current = rows; }, [rows]);

  const load = useCallback(async () => {
    setLoading(true);
    const [cats, txns] = await Promise.all([
      loadAccountCategories(tenantId),
      loadCashTransactions(tenantId, fromIso, toIso),
    ]);
    setCategories(cats);
    setRows(txns.map(toRow));
    setLoading(false);
  }, [tenantId, fromIso, toIso]);
  useEffect(() => { load(); }, [load]);

  const { saveState, scheduleAutosave } = useRowAutosave({
    saveRow: async (key) => {
      const row = rowsRef.current.find(r => r._key === key);
      if (!row) return { ok: true };
      if (!row.id && row.amount <= 0) return { ok: true }; // 빈 draft는 저장 안 함
      const payload: CashTransactionInput = {
        txn_date: row.txn_date, direction: row.direction,
        account_category_id: row.account_category_id, retail_supplier_id: row.retail_supplier_id,
        counterparty_name: row.counterparty_name, amount: row.amount, vat_included: row.vat_included,
        memo: row.memo,
      };
      if (!row.id) {
        const newId = await addCashTransaction(tenantId, payload);
        if (!newId) return { ok: false };
        setRows(prev => prev.map(r => r._key === key ? { ...r, id: newId } : r));
        return { ok: true };
      }
      const ok = await updateCashTransaction(row.id, payload);
      return { ok };
    },
  });

  function patchRow(key: string, patch: Partial<Row>) {
    setRows(prev => prev.map(r => {
      if (r._key !== key) return r;
      const next = { ...r, ...patch };
      if (patch.amount !== undefined || patch.vat_included !== undefined) {
        const s = splitVat(next.amount, next.vat_included);
        next.supply_amount = s.supply_amount;
        next.vat_amount = s.vat_amount;
      }
      return next;
    }));
    scheduleAutosave(key);
  }

  function addDraftRow() {
    setRows(prev => [blankRow(todayIso()), ...prev]);
  }

  async function handleDelete(row: Row) {
    if (row.id) {
      if (!confirm("이 거래를 삭제할까요?")) return;
      await deleteCashTransaction(row.id);
    }
    setRows(prev => prev.filter(r => r._key !== row._key));
  }

  const totals = rows.reduce((acc, r) => {
    if (r.direction === "in") acc.in += r.amount; else acc.out += r.amount;
    return acc;
  }, { in: 0, out: 0 });

  return (
    <div>
      <div className="flex items-center gap-3 mb-4">
        <button type="button" className={styles.btnSmallGhost} onClick={() => setAnchor(a => new Date(a.getFullYear(), a.getMonth() - 1, 1))}>‹</button>
        <div className="text-sm font-bold text-black w-24 text-center">{label}</div>
        <button type="button" className={styles.btnSmallGhost} onClick={() => setAnchor(a => new Date(a.getFullYear(), a.getMonth() + 1, 1))}>›</button>
        <button type="button" className={styles.btnPrimary + " ml-2"} onClick={addDraftRow}>+ 거래 추가</button>
        <div className="ml-auto flex items-center gap-4 text-xs">
          <span className="text-gray-500">입금 <b className="text-black">{formatComma(totals.in)}</b></span>
          <span className="text-gray-500">출금 <b className="text-black">{formatComma(totals.out)}</b></span>
          <span className="text-gray-500">순증감 <b className={totals.in - totals.out >= 0 ? "text-green-600" : "text-red-600"}>{formatComma(totals.in - totals.out)}</b></span>
        </div>
      </div>

      {categories.length === 0 && (
        <div className={styles.msgWarn + " mb-3"}>계정과목이 아직 없어요. &quot;계정과목&quot; 탭에서 먼저 만들어주세요.</div>
      )}

      <div className="border border-gray-200 rounded-lg overflow-hidden">
        <table className="w-full text-xs">
          <thead>
            <tr className="bg-gray-50">
              <th className={styles.th + " w-28"}>날짜</th>
              <th className={styles.th + " w-20"}>구분</th>
              <th className={styles.th + " w-40"}>계정과목</th>
              <th className={styles.thLeft}>거래처</th>
              <th className={styles.th + " w-32"}>금액</th>
              <th className={styles.th + " w-16"}>VAT포함</th>
              <th className={styles.th + " w-28"}>공급가/부가세</th>
              <th className={styles.thLeft + " w-40"}>메모</th>
              <th className={styles.th + " w-10"}></th>
              <th className={styles.th + " w-6"}></th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={10} className="text-center text-gray-400 py-6 text-xs">불러오는 중…</td></tr>
            ) : rows.length === 0 ? (
              <tr><td colSpan={10} className="text-center text-gray-400 py-6 text-xs">이 달 거래가 없어요.</td></tr>
            ) : rows.map(row => (
              <tr key={row._key} className={styles.tr}>
                <td className={styles.tdCenter}>
                  <input type="date" value={row.txn_date} onChange={e => patchRow(row._key, { txn_date: e.target.value })} className={styles.gridInput} />
                </td>
                <td className={styles.tdCenter}>
                  <select value={row.direction} onChange={e => patchRow(row._key, { direction: e.target.value as "in" | "out" })}
                    className={styles.gridInput + (row.direction === "in" ? " text-green-700" : " text-red-700")}>
                    <option value="in">입금</option>
                    <option value="out">출금</option>
                  </select>
                </td>
                <td className={styles.tdCenter}>
                  <select value={row.account_category_id ?? ""} onChange={e => patchRow(row._key, { account_category_id: e.target.value || null })} className={styles.gridInput}>
                    <option value="">선택안함</option>
                    {categories.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                  </select>
                </td>
                <td className={styles.tdText}>
                  <CounterpartyCell
                    tenantId={tenantId}
                    value={row.counterparty_name ?? ""}
                    onPick={(name, sid) => patchRow(row._key, { counterparty_name: name, retail_supplier_id: sid })}
                  />
                </td>
                <td className={styles.tdText}>
                  <input
                    value={formatComma(row.amount)}
                    onChange={e => patchRow(row._key, { amount: Number(parseDigits(e.target.value) || "0") })}
                    className={styles.gridInput + " text-right"}
                  />
                </td>
                <td className={styles.tdCenter}>
                  <input type="checkbox" checked={row.vat_included} onChange={e => patchRow(row._key, { vat_included: e.target.checked })} />
                </td>
                <td className={styles.tdRight + " text-gray-400"}>
                  {formatComma(row.supply_amount)} / {formatComma(row.vat_amount)}
                </td>
                <td className={styles.tdText}>
                  <input value={row.memo ?? ""} onChange={e => patchRow(row._key, { memo: e.target.value || null })} className={styles.gridInput} />
                </td>
                <td className={styles.tdCenter}><SaveStatusDot status={saveState[row._key]} hideWhenIdle={!row.id} /></td>
                <td className={styles.tdCenter}>
                  <button type="button" onClick={() => handleDelete(row)} className="text-gray-300 hover:text-red-600">×</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
