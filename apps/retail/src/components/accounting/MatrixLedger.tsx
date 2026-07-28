"use client";

// 거래처 매트릭스 — 원본 엑셀의 핵심(거래처=세로 한 행, 날짜=가로 열, 한 줄만 보면 스캔 가능)을
// 그대로 살리되 엑셀의 한계(거래처 늘면 칸 부족, 계정입력하면 좌우 좁아짐)는 코드로 없앰.
// 왼쪽 고정열(거래처/계정과목/은행/계좌번호/적요/합계, 마이그 220)은 엑셀 틀고정 그대로 —
// 날짜열만 가로 스크롤. 거래처 행은 월과 무관하게 영속(마이그 219).
// 입력은 철저히 키보드 위주: 거래처/계정과목 모두 "타이핑 후 매칭", 방향/VAT는 토글(Tab+Space).
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { styles } from "@/common/styles";
import { formatComma, parseDigits } from "@/lib/format";
import { useRowAutosave } from "@/lib/useRowAutosave";
import { useCellNavigation } from "@/lib/useCellNavigation";
import CounterpartyCell from "@/components/accounting/CounterpartyCell";
import CategoryCombobox from "@/components/accounting/CategoryCombobox";
import {
  type AccountCategory, type LedgerParty, type AddLedgerPartyInput,
  loadAccountCategories, loadLedgerParties, loadMatrixCells, setMatrixCell,
  findLedgerPartyByName, addLedgerParty, updateLedgerParty, deactivateLedgerParty,
} from "@/lib/accounting";

function monthRange(anchor: Date): { fromIso: string; toIso: string; label: string; days: number[] } {
  const y = anchor.getFullYear(), m = anchor.getMonth();
  const lastDay = new Date(y, m + 1, 0).getDate();
  const iso = (d: number) => `${y}-${String(m + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  return { fromIso: iso(1), toIso: iso(lastDay), label: `${y}년 ${m + 1}월`, days: Array.from({ length: lastDay }, (_, i) => i + 1) };
}

// 왼쪽 고정열 — 거래처/계정과목/은행/계좌번호/적요/합계 순, 여기까지 틀고정 → 날짜열 스크롤.
const FROZEN = [
  { key: "name", label: "거래처", width: 160 },
  { key: "category", label: "계정과목", width: 150 },
  { key: "bank", label: "은행", width: 90 },
  { key: "account", label: "계좌번호", width: 130 },
  { key: "memo", label: "적요", width: 140 },
  { key: "total", label: "합계", width: 100 },
] as const;
const DAY_W = 72;
function frozenLeft(i: number): number { return FROZEN.slice(0, i).reduce((s, c) => s + c.width, 0); }
function frozenStyle(i: number): CSSProperties {
  return { position: "sticky", left: frozenLeft(i), width: FROZEN[i].width, minWidth: FROZEN[i].width, zIndex: 2 };
}

interface Draft {
  name: string;
  supplierId: string | null;
  categoryName: string;
  direction: "in" | "out";
  directionTouched: boolean;
  vat: boolean;
}
const emptyDraft: Draft = { name: "", supplierId: null, categoryName: "", direction: "out", directionTouched: false, vat: false };

export default function MatrixLedger({ tenantId }: { tenantId: string }) {
  const [anchor, setAnchor] = useState(() => new Date());
  const { fromIso, toIso, label, days } = monthRange(anchor);
  const [categories, setCategories] = useState<AccountCategory[]>([]);
  const [parties, setParties] = useState<LedgerParty[]>([]);
  const [cellValues, setCellValues] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const [draftBusy, setDraftBusy] = useState(false);
  const [draftMsg, setDraftMsg] = useState<string | null>(null);

  const partiesRef = useRef<LedgerParty[]>([]);
  useEffect(() => { partiesRef.current = parties; }, [parties]);
  const anchorRef = useRef(anchor);
  useEffect(() => { anchorRef.current = anchor; }, [anchor]);
  const cellValuesRef = useRef(cellValues);
  useEffect(() => { cellValuesRef.current = cellValues; }, [cellValues]);

  const loadAll = useCallback(async () => {
    setLoading(true);
    const [cats, list, cells] = await Promise.all([
      loadAccountCategories(tenantId),
      loadLedgerParties(tenantId),
      loadMatrixCells(tenantId, fromIso, toIso),
    ]);
    setCategories(cats);
    setParties(list);
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
      const [partyId, dayStr] = key.split(":");
      const party = partiesRef.current.find(p => p.id === partyId);
      if (!party) return { ok: true };
      const amount = Number(parseDigits(cellValuesRef.current[key] ?? "0") || "0");
      const ok = await setMatrixCell(tenantId, party, dateForDay(Number(dayStr)), amount);
      return { ok };
    },
  });

  function updateCell(partyId: string, day: number, text: string) {
    const key = `${partyId}:${day}`;
    setCellValues(prev => ({ ...prev, [key]: parseDigits(text) }));
    scheduleAutosave(key);
  }

  const navRows = useMemo(() => parties.map(p => ({ _key: p.id })), [parties]);
  const rowsRefForNav = useRef(navRows);
  useEffect(() => { rowsRefForNav.current = navRows; }, [navRows]);
  const handleNav = useCellNavigation({ rowsRef: rowsRefForNav, cellIdPrefix: "mcell" });

  function patchPartyLocal(id: string, patch: Partial<LedgerParty>) {
    setParties(prev => prev.map(p => p.id === id ? { ...p, ...patch } : p));
  }

  function saveCategoryForParty(party: LedgerParty, categoryId: string, categoryName: string) {
    const cat = categories.find(c => c.id === categoryId);
    patchPartyLocal(party.id, { account_category_id: categoryId, category: { name: cat?.name ?? categoryName, type: cat?.type ?? "판관비" } });
    updateLedgerParty(party.id, { account_category_id: categoryId });
  }

  function saveTextField(party: LedgerParty, field: "bank_name" | "account_number" | "memo", value: string) {
    updateLedgerParty(party.id, { [field]: value || null } as Partial<AddLedgerPartyInput>);
  }

  function toggleDirection(party: LedgerParty) {
    const next = party.direction === "in" ? "out" : "in";
    patchPartyLocal(party.id, { direction: next });
    updateLedgerParty(party.id, { direction: next });
  }

  function toggleVat(party: LedgerParty) {
    const next = !party.vat_included_default;
    patchPartyLocal(party.id, { vat_included_default: next });
    updateLedgerParty(party.id, { vat_included_default: next });
  }

  async function handleRemoveParty(party: LedgerParty) {
    if (!confirm(`"${party.name}" 행을 목록에서 지울까요? (이미 입력된 거래는 그대로 남아요)`)) return;
    await deactivateLedgerParty(party.id);
    setParties(prev => prev.filter(p => p.id !== party.id));
  }

  function inferDirection(categoryName: string): "in" | "out" {
    const cat = categories.find(c => c.name === categoryName);
    return cat?.type === "매출" ? "in" : "out";
  }

  async function finalizeDraft(categoryId: string, categoryName: string) {
    const name = draft.name.trim();
    if (!name || draftBusy) return;
    setDraftBusy(true);
    setDraftMsg(null);
    const existing = await findLedgerPartyByName(tenantId, name);
    if (existing) {
      setDraftBusy(false);
      setDraftMsg(`이미 "${name}" 행이 있어요 — 아래 표에서 바로 입력하세요.`);
      return;
    }
    const direction = draft.directionTouched ? draft.direction : inferDirection(categoryName);
    const created = await addLedgerParty(tenantId, {
      name, retail_supplier_id: draft.supplierId, account_category_id: categoryId,
      direction, vat_included_default: draft.vat,
    });
    setDraftBusy(false);
    if (!created) { setDraftMsg("생성 실패 — 다시 시도해주세요."); return; }
    const cat = categories.find(c => c.id === categoryId);
    const newParty: LedgerParty = { ...created, category: cat ? { name: cat.name, type: cat.type } : null };
    setParties(prev => [...prev, newParty]);
    setDraft(emptyDraft);
    setTimeout(() => document.getElementById(`mcell-${newParty.id}-1`)?.focus(), 50);
  }

  const rowTotal = (partyId: string) => days.reduce((s, d) => s + Number(cellValues[`${partyId}:${d}`] || 0), 0);
  const dayTotal = (day: number, direction: "in" | "out") =>
    parties.filter(p => p.direction === direction).reduce((s, p) => s + Number(cellValues[`${p.id}:${day}`] || 0), 0);
  const grand = (direction: "in" | "out") => days.reduce((s, d) => s + dayTotal(d, direction), 0);

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
              {parties.map(party => (
                <tr key={party.id} className={styles.tr}>
                  <td style={frozenStyle(0)} className="bg-white px-2 py-1.5 border-b border-gray-100">
                    <div className="font-medium text-black truncate" title={party.name}>{party.name}</div>
                    <div className="flex items-center gap-1 mt-0.5">
                      <button type="button" onClick={() => toggleDirection(party)}
                        className={styles.badge + " " + (party.direction === "in" ? "bg-green-50 text-green-700" : "bg-blue-50 text-blue-700")}>
                        {party.direction === "in" ? "입금" : "출금"}
                      </button>
                      <label className="flex items-center gap-0.5 text-[10px] text-gray-400">
                        <input type="checkbox" checked={party.vat_included_default} onChange={() => toggleVat(party)} /> VAT
                      </label>
                    </div>
                  </td>
                  <td style={frozenStyle(1)} className="bg-white border-b border-gray-100 px-1">
                    <CategoryCombobox
                      tenantId={tenantId}
                      categories={categories}
                      value={party.category?.name ?? ""}
                      onTextChange={text => patchPartyLocal(party.id, { category: { name: text, type: party.category?.type ?? "판관비" } })}
                      onPick={(id, name) => saveCategoryForParty(party, id, name)}
                      onCreated={cat => setCategories(prev => [...prev, cat])}
                    />
                  </td>
                  <td style={frozenStyle(2)} className="bg-white border-b border-gray-100 px-1">
                    <input defaultValue={party.bank_name ?? ""} placeholder="은행"
                      onBlur={e => saveTextField(party, "bank_name", e.target.value)} className={styles.gridInput} />
                  </td>
                  <td style={frozenStyle(3)} className="bg-white border-b border-gray-100 px-1">
                    <input defaultValue={party.account_number ?? ""} placeholder="계좌번호"
                      onBlur={e => saveTextField(party, "account_number", e.target.value)} className={styles.gridInput} />
                  </td>
                  <td style={frozenStyle(4)} className="bg-white border-b border-gray-100 px-1">
                    <input defaultValue={party.memo ?? ""} placeholder="적요"
                      onBlur={e => saveTextField(party, "memo", e.target.value)} className={styles.gridInput} />
                  </td>
                  <td style={frozenStyle(5)} className="bg-white border-b border-gray-100 text-right px-2 text-black font-medium">
                    {formatComma(rowTotal(party.id))}
                  </td>
                  {days.map(d => {
                    const key = `${party.id}:${d}`;
                    return (
                      <td key={d} style={{ width: DAY_W, minWidth: DAY_W }} className="border-b border-gray-100 p-0.5">
                        <input
                          id={`mcell-${party.id}-${d}`}
                          value={formatComma(cellValues[key] ?? "")}
                          onChange={e => updateCell(party.id, d, e.target.value)}
                          onKeyDown={e => handleNav(e, party.id, String(d))}
                          className={styles.gridInput + " text-right" + (saveState[key] === "saving" ? " bg-gray-100" : saveState[key] === "error" ? " ring-1 ring-red-400" : "")}
                        />
                      </td>
                    );
                  })}
                  <td className="text-center border-b border-gray-100">
                    <button type="button" onClick={() => handleRemoveParty(party)} className="text-gray-300 hover:text-red-600">×</button>
                  </td>
                </tr>
              ))}

              {/* 새 거래처 추가 draft — 이름 → 계정과목(Enter=확정) 순, VAT/방향은 옆에서 미리 토글 */}
              <tr className="bg-amber-50/40">
                <td style={frozenStyle(0)} className="bg-amber-50 px-2 py-1.5">
                  <CounterpartyCell
                    tenantId={tenantId}
                    value={draft.name}
                    placeholder="+ 새 거래처명"
                    onPick={(name, sid) => setDraft(d => ({ ...d, name, supplierId: sid }))}
                  />
                </td>
                <td style={frozenStyle(1)} className="bg-amber-50 px-1">
                  <CategoryCombobox
                    tenantId={tenantId}
                    categories={categories}
                    value={draft.categoryName}
                    onTextChange={text => setDraft(d => ({ ...d, categoryName: text }))}
                    onPick={(id, name) => { setDraft(d => ({ ...d, categoryName: name })); finalizeDraft(id, name); }}
                    onCreated={cat => setCategories(prev => [...prev, cat])}
                  />
                </td>
                <td style={{ position: "sticky", left: frozenLeft(2), width: FROZEN[2].width + FROZEN[3].width + FROZEN[4].width, zIndex: 2 }}
                  className="bg-amber-50 px-2 text-gray-500">
                  <div className="flex items-center gap-2">
                    <label className="flex items-center gap-1 whitespace-nowrap">
                      <input type="checkbox" checked={draft.vat} onChange={e => setDraft(d => ({ ...d, vat: e.target.checked }))} /> VAT
                    </label>
                    <button type="button"
                      onClick={() => setDraft(d => ({ ...d, direction: d.direction === "in" ? "out" : "in", directionTouched: true }))}
                      className={styles.btnSmallGhost + " whitespace-nowrap"}>
                      {draft.direction === "in" ? "입금" : "출금"}
                    </button>
                  </div>
                </td>
                <td style={frozenStyle(5)} className="bg-amber-50"></td>
                <td colSpan={days.length} className="px-2 text-xs text-amber-700">
                  {draftBusy ? "저장 중…" : draftMsg}
                </td>
                <td></td>
              </tr>

              <tr className="border-t-2 border-gray-300 bg-gray-50">
                <td style={{ position: "sticky", left: 0, width: frozenLeft(5), zIndex: 2 }} colSpan={5}
                  className="bg-gray-50 px-2 py-1 font-medium text-green-700">입금합계</td>
                <td style={frozenStyle(5)} className="bg-gray-50 text-right px-2 font-bold text-green-700">{formatComma(grand("in"))}</td>
                {days.map(d => <td key={d} style={{ width: DAY_W, minWidth: DAY_W }} className="text-right px-1 text-green-700">{formatComma(dayTotal(d, "in"))}</td>)}
                <td></td>
              </tr>
              <tr className="bg-gray-50">
                <td style={{ position: "sticky", left: 0, width: frozenLeft(5), zIndex: 2 }} colSpan={5}
                  className="bg-gray-50 px-2 py-1 font-medium text-red-700">출금합계</td>
                <td style={frozenStyle(5)} className="bg-gray-50 text-right px-2 font-bold text-red-700">{formatComma(grand("out"))}</td>
                {days.map(d => <td key={d} style={{ width: DAY_W, minWidth: DAY_W }} className="text-right px-1 text-red-700">{formatComma(dayTotal(d, "out"))}</td>)}
                <td></td>
              </tr>
              <tr className="bg-gray-50">
                <td style={{ position: "sticky", left: 0, width: frozenLeft(5), zIndex: 2 }} colSpan={5}
                  className="bg-gray-50 px-2 py-1 font-medium text-black">순증감</td>
                <td style={frozenStyle(5)} className={"bg-gray-50 text-right px-2 font-bold " + (grand("in") - grand("out") >= 0 ? "text-black" : "text-red-600")}>
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
