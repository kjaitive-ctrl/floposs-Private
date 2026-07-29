"use client";

// 입출금 매트릭스 — 거래처=세로 행, 날짜=가로 열, 입금/출금 위아래 섹션.
// 셀 하나 = 통장에 찍힌 실제 숫자 그대로(부가세/원천징수 분해 없음).
// DB 트리거가 뒤에서 단순 2줄 전표(현금↔해당계정)를 자동 생성 — 실제
// 분개(후처리)는 전표 화면(다음 라운드)에서. 행은 적요만으로 생성,
// 거래처/계정은 나중에 채워도 됨 + 월 무관 영속(이월). 마이그 225.
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { styles } from "@/common/styles";
import { formatComma, parseDigits } from "@/lib/format";
import { useRowAutosave } from "@/lib/useRowAutosave";
import { useCellNavigation } from "@/lib/useCellNavigation";
import AccountCombobox from "@/components/accounting/AccountCombobox";
import CounterpartyCombobox from "@/components/accounting/CounterpartyCombobox";
import {
  type Account, type Counterparty, type CashLineItem,
  loadAccounts, loadCounterparties, loadCashLineItems, loadCashEntries, setCashEntry,
  addCashLineItem, updateCashLineItem, deactivateCashLineItem, updateCounterparty,
} from "@/lib/accounting";

function monthRange(anchor: Date): { fromIso: string; toIso: string; label: string; days: number[] } {
  const y = anchor.getFullYear(), m = anchor.getMonth();
  const lastDay = new Date(y, m + 1, 0).getDate();
  const iso = (d: number) => `${y}-${String(m + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  return { fromIso: iso(1), toIso: iso(lastDay), label: `${y}년 ${m + 1}월`, days: Array.from({ length: lastDay }, (_, i) => i + 1) };
}

const FROZEN = [
  { key: "name", label: "거래처", width: 130 },
  { key: "holder", label: "예금주", width: 80 },
  { key: "bank", label: "은행", width: 80 },
  { key: "account", label: "계좌번호", width: 110 },
  { key: "acct", label: "계정", width: 110 },
  { key: "mgmt", label: "관리항목", width: 90 },
  { key: "memo", label: "적요", width: 110 },
  { key: "total", label: "합계", width: 90 },
] as const;
const DAY_W = 68;
function frozenLeft(i: number): number { return FROZEN.slice(0, i).reduce((s, c) => s + c.width, 0); }
function frozenStyle(i: number): CSSProperties {
  return { position: "sticky", left: frozenLeft(i), width: FROZEN[i].width, minWidth: FROZEN[i].width, zIndex: 2 };
}
const TOTAL_IDX = FROZEN.length - 1;

interface Draft {
  counterpartyId: string | null;
  counterpartyName: string;
  accountId: string | null;
  accountName: string;
  managementTag: string;
  memo: string;
}
const emptyDraft: Draft = { counterpartyId: null, counterpartyName: "", accountId: null, accountName: "", managementTag: "", memo: "" };

export default function CashMatrix({ tenantId }: { tenantId: string }) {
  const [anchor, setAnchor] = useState(() => new Date());
  const { fromIso, toIso, label, days } = monthRange(anchor);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [counterparties, setCounterparties] = useState<Counterparty[]>([]);
  const [items, setItems] = useState<CashLineItem[]>([]);
  const [cellValues, setCellValues] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [draftIn, setDraftIn] = useState<Draft>(emptyDraft);
  const [draftOut, setDraftOut] = useState<Draft>(emptyDraft);
  const [draftBusy, setDraftBusy] = useState<"in" | "out" | null>(null);

  const itemsRef = useRef<CashLineItem[]>([]);
  useEffect(() => { itemsRef.current = items; }, [items]);
  const anchorRef = useRef(anchor);
  useEffect(() => { anchorRef.current = anchor; }, [anchor]);
  const cellValuesRef = useRef(cellValues);
  useEffect(() => { cellValuesRef.current = cellValues; }, [cellValues]);

  const loadAll = useCallback(async () => {
    setLoading(true);
    const [accs, cps, list, cells] = await Promise.all([
      loadAccounts(tenantId),
      loadCounterparties(tenantId),
      loadCashLineItems(tenantId),
      loadCashEntries(tenantId, fromIso, toIso),
    ]);
    setAccounts(accs);
    setCounterparties(cps);
    setItems(list);
    const vals: Record<string, string> = {};
    for (const [key, amount] of cells) vals[key] = String(amount);
    setCellValues(vals);
    setLoading(false);
  }, [tenantId, fromIso, toIso]);
  useEffect(() => { loadAll(); }, [loadAll]);

  function dateForDay(day: number): string {
    const a = anchorRef.current;
    return `${a.getFullYear()}-${String(a.getMonth() + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  }

  const { saveState, scheduleAutosave } = useRowAutosave({
    saveRow: async (key) => {
      const [itemId, dayStr] = key.split(":");
      if (!itemsRef.current.find(i => i.id === itemId)) return { ok: true };
      const amount = Number(parseDigits(cellValuesRef.current[key] ?? "0") || "0");
      const ok = await setCashEntry(tenantId, itemId, dateForDay(Number(dayStr)), amount);
      return { ok };
    },
  });

  function updateCell(itemId: string, day: number, text: string) {
    const key = `${itemId}:${day}`;
    setCellValues(prev => ({ ...prev, [key]: parseDigits(text) }));
    scheduleAutosave(key);
  }

  const navRows = useMemo(() => items.map(i => ({ _key: i.id })), [items]);
  const rowsRefForNav = useRef(navRows);
  useEffect(() => { rowsRefForNav.current = navRows; }, [navRows]);
  const handleNav = useCellNavigation({ rowsRef: rowsRefForNav, cellIdPrefix: "cmcell" });

  function patchItemLocal(id: string, patch: Partial<CashLineItem>) {
    setItems(prev => prev.map(i => i.id === id ? { ...i, ...patch } : i));
  }

  function saveAccountForItem(item: CashLineItem, accountId: string, accountName: string) {
    const acc = accounts.find(a => a.id === accountId);
    patchItemLocal(item.id, { account_id: accountId, account: acc ? { code: acc.code, name: acc.name, gubun: acc.gubun } : { code: 0, name: accountName, gubun: "비용" } });
    updateCashLineItem(item.id, { account_id: accountId });
  }

  function saveCounterpartyForItem(item: CashLineItem, cpId: string, cpName: string) {
    const cp = counterparties.find(c => c.id === cpId);
    patchItemLocal(item.id, { counterparty_id: cpId, counterparty: cp ?? { id: cpId, name: cpName, account_holder: null, bank_name: null, account_number: null, memo: null } });
    updateCashLineItem(item.id, { counterparty_id: cpId });
  }

  function saveCounterpartyField(item: CashLineItem, field: "account_holder" | "bank_name" | "account_number", value: string) {
    if (!item.counterparty_id) return;
    patchItemLocal(item.id, { counterparty: item.counterparty ? { ...item.counterparty, [field]: value || null } : item.counterparty });
    updateCounterparty(item.counterparty_id, { [field]: value || null });
  }

  function saveTextField(item: CashLineItem, field: "management_tag" | "memo", value: string) {
    updateCashLineItem(item.id, { [field]: value || null });
  }

  async function handleRemoveItem(item: CashLineItem) {
    if (!confirm(`"${item.memo || item.counterparty?.name || "(이름 없음)"}" 행을 지울까요? (이미 입력된 거래는 그대로 남아요)`)) return;
    await deactivateCashLineItem(item.id);
    setItems(prev => prev.filter(i => i.id !== item.id));
  }

  // 적요(성격 메모)만 있으면 행 생성 — 거래처/계정은 나중에 채워도 됨.
  async function finalizeDraft(direction: "in" | "out", draft: Draft, setDraft: (d: Draft) => void) {
    const memo = draft.memo.trim();
    if (!memo || draftBusy) return;
    setDraftBusy(direction);
    const created = await addCashLineItem(tenantId, {
      direction, account_id: draft.accountId, counterparty_id: draft.counterpartyId,
      management_tag: draft.managementTag.trim() || null, memo,
    });
    setDraftBusy(null);
    if (!created) return;
    const acc = accounts.find(a => a.id === draft.accountId);
    const cp = counterparties.find(c => c.id === draft.counterpartyId);
    const newItem: CashLineItem = { ...created, account: acc ? { code: acc.code, name: acc.name, gubun: acc.gubun } : null, counterparty: cp ?? null };
    setItems(prev => [...prev, newItem]);
    setDraft(emptyDraft);
    setTimeout(() => document.getElementById(`cmcell-${newItem.id}-1`)?.focus(), 50);
  }

  const rowTotal = (itemId: string) => days.reduce((s, d) => s + Number(cellValues[`${itemId}:${d}`] || 0), 0);
  const dayTotal = (day: number, direction: "in" | "out") =>
    items.filter(i => i.direction === direction).reduce((s, i) => s + Number(cellValues[`${i.id}:${day}`] || 0), 0);
  const grand = (direction: "in" | "out") => days.reduce((s, d) => s + dayTotal(d, direction), 0);

  const inItems = items.filter(i => i.direction === "in");
  const outItems = items.filter(i => i.direction === "out");

  function renderItemRow(item: CashLineItem) {
    return (
      <tr key={item.id} className={styles.tr}>
        <td style={frozenStyle(0)} className="bg-white border-b border-gray-100 px-1">
          <CounterpartyCombobox
            id={`cmcell-${item.id}-name`}
            tenantId={tenantId} counterparties={counterparties}
            value={item.counterparty?.name ?? ""}
            onTextChange={text => patchItemLocal(item.id, { counterparty: item.counterparty ? { ...item.counterparty, name: text } : { id: "", name: text, account_holder: null, bank_name: null, account_number: null, memo: null } })}
            onPick={(id, name) => saveCounterpartyForItem(item, id, name)}
            onCreated={cp => setCounterparties(prev => [...prev, cp])}
          />
        </td>
        <td style={frozenStyle(1)} className="bg-white border-b border-gray-100 px-1">
          <input defaultValue={item.counterparty?.account_holder ?? ""} placeholder="예금주" disabled={!item.counterparty_id}
            onBlur={e => saveCounterpartyField(item, "account_holder", e.target.value)} className={styles.gridInput} />
        </td>
        <td style={frozenStyle(2)} className="bg-white border-b border-gray-100 px-1">
          <input defaultValue={item.counterparty?.bank_name ?? ""} placeholder="은행" disabled={!item.counterparty_id}
            onBlur={e => saveCounterpartyField(item, "bank_name", e.target.value)} className={styles.gridInput} />
        </td>
        <td style={frozenStyle(3)} className="bg-white border-b border-gray-100 px-1">
          <input defaultValue={item.counterparty?.account_number ?? ""} placeholder="계좌번호" disabled={!item.counterparty_id}
            onBlur={e => saveCounterpartyField(item, "account_number", e.target.value)} className={styles.gridInput} />
        </td>
        <td style={frozenStyle(4)} className="bg-white border-b border-gray-100 px-1">
          <AccountCombobox
            tenantId={tenantId} accounts={accounts} value={item.account?.name ?? ""}
            defaultGubunForNew={item.direction === "in" ? "수익" : "비용"}
            onTextChange={text => patchItemLocal(item.id, { account: { code: item.account?.code ?? 0, name: text, gubun: item.account?.gubun ?? "비용" } })}
            onPick={(id, name) => saveAccountForItem(item, id, name)}
            onCreated={acc => setAccounts(prev => [...prev, acc])}
          />
        </td>
        <td style={frozenStyle(5)} className="bg-white border-b border-gray-100 px-1">
          <input defaultValue={item.management_tag ?? ""} placeholder="관리항목"
            onBlur={e => saveTextField(item, "management_tag", e.target.value)} className={styles.gridInput} />
        </td>
        <td style={frozenStyle(6)} className="bg-white border-b border-gray-100 px-1">
          <input defaultValue={item.memo ?? ""} placeholder="적요"
            onBlur={e => saveTextField(item, "memo", e.target.value)} className={styles.gridInput} />
        </td>
        <td style={frozenStyle(TOTAL_IDX)} className="bg-white border-b border-gray-100 text-right px-2 text-black font-medium">
          {formatComma(rowTotal(item.id))}
        </td>
        {days.map(d => {
          const key = `${item.id}:${d}`;
          return (
            <td key={d} style={{ width: DAY_W, minWidth: DAY_W }} className="border-b border-gray-100 p-0.5">
              <input
                id={`cmcell-${item.id}-${d}`}
                value={formatComma(cellValues[key] ?? "")}
                onChange={e => updateCell(item.id, d, e.target.value)}
                onKeyDown={e => handleNav(e, item.id, String(d))}
                className={styles.gridInput + " text-right" + (saveState[key] === "saving" ? " bg-gray-100" : saveState[key] === "error" ? " ring-1 ring-red-400" : "")}
              />
            </td>
          );
        })}
        <td className="text-center border-b border-gray-100">
          <button type="button" onClick={() => handleRemoveItem(item)} className="text-gray-300 hover:text-red-600">×</button>
        </td>
      </tr>
    );
  }

  function renderDraftRow(direction: "in" | "out", draft: Draft, setDraft: (d: Draft) => void) {
    return (
      <tr className="bg-amber-50/40">
        <td style={frozenStyle(0)} className="bg-amber-50 px-1">
          <CounterpartyCombobox tenantId={tenantId} counterparties={counterparties} value={draft.counterpartyName}
            onTextChange={text => setDraft({ ...draft, counterpartyName: text })}
            onPick={(id, name) => setDraft({ ...draft, counterpartyId: id, counterpartyName: name })}
            onCreated={cp => setCounterparties(prev => [...prev, cp])} />
        </td>
        <td style={frozenStyle(1)} className="bg-amber-50"></td>
        <td style={frozenStyle(2)} className="bg-amber-50"></td>
        <td style={frozenStyle(3)} className="bg-amber-50"></td>
        <td style={frozenStyle(4)} className="bg-amber-50 px-1">
          <AccountCombobox tenantId={tenantId} accounts={accounts} value={draft.accountName}
            defaultGubunForNew={direction === "in" ? "수익" : "비용"}
            onTextChange={text => setDraft({ ...draft, accountName: text })}
            onPick={(id, name) => setDraft({ ...draft, accountId: id, accountName: name })}
            onCreated={acc => setAccounts(prev => [...prev, acc])} />
        </td>
        <td style={frozenStyle(5)} className="bg-amber-50 px-1">
          <input value={draft.managementTag} placeholder="관리항목" onChange={e => setDraft({ ...draft, managementTag: e.target.value })} className={styles.gridInput} />
        </td>
        <td style={frozenStyle(6)} className="bg-amber-50 px-1">
          <input
            value={draft.memo}
            placeholder="항목명(예: 법인폰대금) — Enter로 행 생성"
            onChange={e => setDraft({ ...draft, memo: e.target.value })}
            onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); finalizeDraft(direction, draft, setDraft); } }}
            className={styles.gridInput + " ring-1 ring-inset ring-amber-300"}
          />
        </td>
        <td style={frozenStyle(TOTAL_IDX)} className="bg-amber-50"></td>
        <td colSpan={days.length} className="px-2 text-xs text-amber-700">{draftBusy === direction ? "저장 중…" : ""}</td>
        <td></td>
      </tr>
    );
  }

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
        <div className="overflow-x-auto border border-gray-200 rounded-lg">
          <table className="text-xs border-collapse">
            <thead>
              <tr className="bg-gray-50">
                {FROZEN.map((c, i) => (
                  <th key={c.key} style={frozenStyle(i)} className={(i === 0 ? styles.thLeft : styles.th) + " bg-gray-50"}>{c.label}</th>
                ))}
                {days.map(d => <th key={d} style={{ width: DAY_W, minWidth: DAY_W }} className={styles.th}>{d}</th>)}
                <th className={styles.th + " w-6"}></th>
              </tr>
            </thead>
            <tbody>
              <tr className="bg-green-50/60">
                <td style={{ position: "sticky", left: 0, width: frozenLeft(TOTAL_IDX) + FROZEN[TOTAL_IDX].width, zIndex: 2 }} colSpan={FROZEN.length}
                  className="bg-green-50 px-2 py-1 text-sm font-bold text-green-700">입금</td>
                <td colSpan={days.length + 1}></td>
              </tr>
              {inItems.map(renderItemRow)}
              {renderDraftRow("in", draftIn, setDraftIn)}
              <tr className="border-t-2 border-gray-300 bg-gray-50">
                <td style={{ position: "sticky", left: 0, width: frozenLeft(TOTAL_IDX), zIndex: 2 }} colSpan={TOTAL_IDX}
                  className="bg-gray-50 px-2 py-1 font-medium text-green-700">입금합계</td>
                <td style={frozenStyle(TOTAL_IDX)} className="bg-gray-50 text-right px-2 font-bold text-green-700">{formatComma(grand("in"))}</td>
                {days.map(d => <td key={d} style={{ width: DAY_W, minWidth: DAY_W }} className="text-right px-1 text-green-700">{formatComma(dayTotal(d, "in"))}</td>)}
                <td></td>
              </tr>

              <tr className="bg-blue-50/60">
                <td style={{ position: "sticky", left: 0, width: frozenLeft(TOTAL_IDX) + FROZEN[TOTAL_IDX].width, zIndex: 2 }} colSpan={FROZEN.length}
                  className="bg-blue-50 px-2 py-1 text-sm font-bold text-blue-700">출금</td>
                <td colSpan={days.length + 1}></td>
              </tr>
              {outItems.map(renderItemRow)}
              {renderDraftRow("out", draftOut, setDraftOut)}
              <tr className="border-t-2 border-gray-300 bg-gray-50">
                <td style={{ position: "sticky", left: 0, width: frozenLeft(TOTAL_IDX), zIndex: 2 }} colSpan={TOTAL_IDX}
                  className="bg-gray-50 px-2 py-1 font-medium text-red-700">출금합계</td>
                <td style={frozenStyle(TOTAL_IDX)} className="bg-gray-50 text-right px-2 font-bold text-red-700">{formatComma(grand("out"))}</td>
                {days.map(d => <td key={d} style={{ width: DAY_W, minWidth: DAY_W }} className="text-right px-1 text-red-700">{formatComma(dayTotal(d, "out"))}</td>)}
                <td></td>
              </tr>

              <tr className="bg-gray-100">
                <td style={{ position: "sticky", left: 0, width: frozenLeft(TOTAL_IDX), zIndex: 2 }} colSpan={TOTAL_IDX}
                  className="bg-gray-100 px-2 py-1 font-bold text-black">순증감</td>
                <td style={frozenStyle(TOTAL_IDX)} className={"bg-gray-100 text-right px-2 font-bold " + (grand("in") - grand("out") >= 0 ? "text-black" : "text-red-600")}>
                  {formatComma(grand("in") - grand("out"))}
                </td>
                {days.map(d => {
                  const v = dayTotal(d, "in") - dayTotal(d, "out");
                  return <td key={d} style={{ width: DAY_W, minWidth: DAY_W }} className={"text-right px-1 " + (v >= 0 ? "text-black" : "text-red-600")}>{formatComma(v)}</td>;
                })}
                <td></td>
              </tr>
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
