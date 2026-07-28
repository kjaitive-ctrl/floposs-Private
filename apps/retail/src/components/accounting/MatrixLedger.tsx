"use client";

// 거래처 매트릭스 — 원본 엑셀의 핵심(거래처=세로 한 행, 날짜=가로 열, 한 줄만 보면 스캔 가능)을
// 그대로 살리되 엑셀의 한계(거래처 늘면 칸 부족, 계정입력하면 좌우 좁아짐)는 코드로 없앰.
// 입금/출금을 위아래 두 섹션으로 나눔(11.xlsx 시트'1' 최신 초안) — 방향은 섹션이
// 정하므로 행마다 토글 불필요, 각 섹션 맨 아래 자기 "+새 거래처" draft 로 계속 추가.
//
// 행 생성 = 적요(성격 메모, 예: "정산금") 만으로 충분 — 거래처/계정과목은 나중에
// 채워도 됨. 완성도 강제는 입력 시점이 아니라 "마감" 시점으로 미룸(사장님 결정):
// 부족한 행(계정과목 없음)이 있으면 그 달을 마감할 수 없다. 마감된 달은 읽기전용.
//
// 왼쪽 고정열: 거래처/계정과목/관리항목/은행/계좌번호/증빙/적요/합계, 여기까지 틀고정 →
// 날짜열만 스크롤. 거래처 행은 월과 무관하게 영속(마이그 219/222/223).
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
  loadPeriodStatus, closeMonth, reopenMonth,
  loadCashBalanceAnchor, setCashBalanceAnchor, loadNetCashDelta,
} from "@/lib/accounting";

function monthRange(anchor: Date): { fromIso: string; toIso: string; label: string; days: number[] } {
  const y = anchor.getFullYear(), m = anchor.getMonth();
  const lastDay = new Date(y, m + 1, 0).getDate();
  const iso = (d: number) => `${y}-${String(m + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  return { fromIso: iso(1), toIso: iso(lastDay), label: `${y}년 ${m + 1}월`, days: Array.from({ length: lastDay }, (_, i) => i + 1) };
}

// 왼쪽 고정열 — 거래처/계정과목/관리항목/은행/계좌번호/증빙/적요/합계 (11.xlsx 시트'1' 초안).
// 방향(입금/출금)은 섹션으로 이미 구분되니 별도 열 없음.
const FROZEN = [
  { key: "name", label: "거래처", width: 140 },
  { key: "category", label: "계정과목", width: 130 },
  { key: "mgmt", label: "관리항목", width: 100 },
  { key: "bank", label: "은행", width: 90 },
  { key: "account", label: "계좌번호", width: 120 },
  { key: "evidence", label: "증빙", width: 100 },
  { key: "memo", label: "적요", width: 130 },
  { key: "total", label: "합계", width: 90 },
] as const;
const DAY_W = 68;
function frozenLeft(i: number): number { return FROZEN.slice(0, i).reduce((s, c) => s + c.width, 0); }
function frozenStyle(i: number): CSSProperties {
  return { position: "sticky", left: frozenLeft(i), width: FROZEN[i].width, minWidth: FROZEN[i].width, zIndex: 2 };
}
const TOTAL_IDX = FROZEN.length - 1;

interface Draft {
  name: string;
  supplierId: string | null;
  categoryId: string | null;
  categoryName: string;
  managementTag: string;
  bankName: string;
  accountNumber: string;
  evidenceType: string;
  memo: string;
  vat: boolean;
}
const emptyDraft: Draft = {
  name: "", supplierId: null, categoryId: null, categoryName: "",
  managementTag: "", bankName: "", accountNumber: "", evidenceType: "", memo: "", vat: false,
};

export default function MatrixLedger({ tenantId }: { tenantId: string }) {
  const [anchor, setAnchor] = useState(() => new Date());
  const { fromIso, toIso, label, days } = monthRange(anchor);
  const periodMonthIso = fromIso; // 항상 그 달 1일
  const [categories, setCategories] = useState<AccountCategory[]>([]);
  const [parties, setParties] = useState<LedgerParty[]>([]);
  const [cellValues, setCellValues] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [draftIn, setDraftIn] = useState<Draft>(emptyDraft);
  const [draftOut, setDraftOut] = useState<Draft>(emptyDraft);
  const [draftBusy, setDraftBusy] = useState<"in" | "out" | null>(null);
  const [draftMsg, setDraftMsg] = useState<{ dir: "in" | "out"; text: string } | null>(null);
  const [closed, setClosed] = useState(false);
  const [closedAt, setClosedAt] = useState<string | null>(null);
  const [closeErr, setCloseErr] = useState<string | null>(null);
  const [openingBalance, setOpeningBalance] = useState<number | null>(null);
  const [anchorForm, setAnchorForm] = useState(false);
  const [anchorDate, setAnchorDate] = useState(() => new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Seoul" }));
  const [anchorAmount, setAnchorAmount] = useState("");

  const partiesRef = useRef<LedgerParty[]>([]);
  useEffect(() => { partiesRef.current = parties; }, [parties]);
  const anchorRef = useRef(anchor);
  useEffect(() => { anchorRef.current = anchor; }, [anchor]);
  const cellValuesRef = useRef(cellValues);
  useEffect(() => { cellValuesRef.current = cellValues; }, [cellValues]);

  const loadAll = useCallback(async () => {
    setLoading(true);
    setCloseErr(null);
    const [cats, list, cells, period, anchorInfo] = await Promise.all([
      loadAccountCategories(tenantId),
      loadLedgerParties(tenantId),
      loadMatrixCells(tenantId, fromIso, toIso),
      loadPeriodStatus(tenantId, periodMonthIso),
      loadCashBalanceAnchor(tenantId),
    ]);
    setCategories(cats);
    setParties(list);
    const vals: Record<string, string> = {};
    for (const [key, amount] of cells) vals[key] = String(amount);
    setCellValues(vals);
    setClosed(period.closed);
    setClosedAt(period.closedAt);
    if (anchorInfo) {
      const dayBefore = new Date(fromIso);
      dayBefore.setDate(dayBefore.getDate() - 1);
      const dayBeforeIso = dayBefore.toLocaleDateString("en-CA");
      const delta = await loadNetCashDelta(tenantId, anchorInfo.as_of_date, dayBeforeIso);
      setOpeningBalance(anchorInfo.amount + delta);
    } else {
      setOpeningBalance(null);
    }
    setLoading(false);
  }, [tenantId, fromIso, toIso, periodMonthIso]);
  useEffect(() => { loadAll(); }, [loadAll]);

  async function handleSaveAnchor() {
    const amount = Number(parseDigits(anchorAmount) || "0");
    await setCashBalanceAnchor(tenantId, anchorDate, amount);
    setAnchorForm(false);
    setAnchorAmount("");
    loadAll();
  }

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
    if (closed) return;
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

  function saveNameForParty(party: LedgerParty, name: string, supplierId: string | null) {
    patchPartyLocal(party.id, { name, retail_supplier_id: supplierId });
    updateLedgerParty(party.id, { name: name || null, retail_supplier_id: supplierId });
  }

  type TextField = "bank_name" | "account_number" | "memo" | "management_tag" | "evidence_type";
  function saveTextField(party: LedgerParty, field: TextField, value: string) {
    updateLedgerParty(party.id, { [field]: value || null } as Partial<AddLedgerPartyInput>);
  }

  function toggleVat(party: LedgerParty) {
    const next = !party.vat_included_default;
    patchPartyLocal(party.id, { vat_included_default: next });
    updateLedgerParty(party.id, { vat_included_default: next });
  }

  async function handleRemoveParty(party: LedgerParty) {
    if (!confirm(`"${party.name || "(이름 없음)"}" 행을 목록에서 지울까요? (이미 입력된 거래는 그대로 남아요)`)) return;
    await deactivateLedgerParty(party.id);
    setParties(prev => prev.filter(p => p.id !== party.id));
  }

  // 적요(성격 메모)만 있으면 행 생성 — 거래처/계정과목은 나중에 채워도 됨.
  async function finalizeDraft(direction: "in" | "out", draft: Draft, setDraft: (d: Draft) => void) {
    const memo = draft.memo.trim();
    if (!memo || draftBusy) return;
    setDraftBusy(direction);
    setDraftMsg(null);
    if (draft.name.trim()) {
      const existing = await findLedgerPartyByName(tenantId, draft.name.trim());
      if (existing) {
        setDraftBusy(null);
        setDraftMsg({ dir: direction, text: `이미 "${draft.name}" 행이 있어요 — 아래 표에서 바로 입력하세요.` });
        return;
      }
    }
    const created = await addLedgerParty(tenantId, {
      name: draft.name.trim() || null,
      retail_supplier_id: draft.supplierId,
      account_category_id: draft.categoryId,
      direction, vat_included_default: draft.vat,
      management_tag: draft.managementTag.trim() || null,
      bank_name: draft.bankName.trim() || null,
      account_number: draft.accountNumber.trim() || null,
      evidence_type: draft.evidenceType.trim() || null,
      memo,
    });
    setDraftBusy(null);
    if (!created) { setDraftMsg({ dir: direction, text: "생성 실패 — 다시 시도해주세요." }); return; }
    const cat = categories.find(c => c.id === draft.categoryId);
    const newParty: LedgerParty = { ...created, category: cat ? { name: cat.name, type: cat.type } : null };
    setParties(prev => [...prev, newParty]);
    setDraft(emptyDraft);
    setTimeout(() => document.getElementById(`mcell-${newParty.id}-name`)?.focus(), 50);
  }

  const rowTotal = (partyId: string) => days.reduce((s, d) => s + Number(cellValues[`${partyId}:${d}`] || 0), 0);
  const dayTotal = (day: number, direction: "in" | "out") =>
    parties.filter(p => p.direction === direction).reduce((s, p) => s + Number(cellValues[`${p.id}:${day}`] || 0), 0);
  const grand = (direction: "in" | "out") => days.reduce((s, d) => s + dayTotal(d, direction), 0);

  // 기초/기말잔액 — 통장 기준잔액(마이그 224) + 그날까지의 순증감 누적. 기준잔액 미설정 시 표시 안 함.
  const dailyClosing: Record<number, number> = {};
  if (openingBalance !== null) {
    let running = openingBalance;
    for (const d of days) {
      running += dayTotal(d, "in") - dayTotal(d, "out");
      dailyClosing[d] = running;
    }
  }
  function dailyOpeningFor(d: number): number | null {
    if (openingBalance === null) return null;
    return d === 1 ? openingBalance : dailyClosing[d - 1];
  }
  const monthEndClosing = openingBalance === null ? null : dailyClosing[days[days.length - 1]];

  const inParties = parties.filter(p => p.direction === "in");
  const outParties = parties.filter(p => p.direction === "out");

  // 이 달에 실제 쓰인(0원 아닌 셀 있는) 행 중 계정과목 없는 것 — 마감 가로막는 목록.
  const usedThisMonth = (p: LedgerParty) => days.some(d => Number(cellValues[`${p.id}:${d}`] || 0) > 0);
  const incompleteParties = parties.filter(p => usedThisMonth(p) && !p.account_category_id);

  async function handleClose() {
    if (incompleteParties.length > 0) {
      setCloseErr(`계정과목이 없는 행이 ${incompleteParties.length}개 있어 마감할 수 없어요: ${incompleteParties.map(p => p.name || "(이름 없음)").join(", ")}`);
      return;
    }
    setCloseErr(null);
    await closeMonth(tenantId, periodMonthIso);
    setClosed(true);
    setClosedAt(new Date().toISOString());
  }

  async function handleReopen() {
    if (!confirm("이 달 마감을 취소할까요? 다시 입력/수정할 수 있게 됩니다.")) return;
    await reopenMonth(tenantId, periodMonthIso);
    setClosed(false);
    setClosedAt(null);
  }

  function renderPartyRow(party: LedgerParty) {
    return (
      <tr key={party.id} className={styles.tr}>
        <td style={frozenStyle(0)} className="bg-white border-b border-gray-100 px-1 py-1.5">
          <CounterpartyCell
            id={`mcell-${party.id}-name`}
            tenantId={tenantId}
            value={party.name ?? ""}
            readOnly={closed}
            onPick={(name, sid) => saveNameForParty(party, name, sid)}
          />
          <label className="flex items-center gap-0.5 text-[9px] text-gray-400 px-1">
            <input type="checkbox" checked={party.vat_included_default} disabled={closed} onChange={() => toggleVat(party)} /> VAT포함
          </label>
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
          <input defaultValue={party.management_tag ?? ""} placeholder="관리항목" readOnly={closed}
            onBlur={e => saveTextField(party, "management_tag", e.target.value)} className={styles.gridInput} />
        </td>
        <td style={frozenStyle(3)} className="bg-white border-b border-gray-100 px-1">
          <input defaultValue={party.bank_name ?? ""} placeholder="은행" readOnly={closed}
            onBlur={e => saveTextField(party, "bank_name", e.target.value)} className={styles.gridInput} />
        </td>
        <td style={frozenStyle(4)} className="bg-white border-b border-gray-100 px-1">
          <input defaultValue={party.account_number ?? ""} placeholder="계좌번호" readOnly={closed}
            onBlur={e => saveTextField(party, "account_number", e.target.value)} className={styles.gridInput} />
        </td>
        <td style={frozenStyle(5)} className="bg-white border-b border-gray-100 px-1">
          <input defaultValue={party.evidence_type ?? ""} placeholder="증빙" readOnly={closed}
            onBlur={e => saveTextField(party, "evidence_type", e.target.value)} className={styles.gridInput} />
        </td>
        <td style={frozenStyle(6)} className="bg-white border-b border-gray-100 px-1">
          <input defaultValue={party.memo ?? ""} placeholder="적요" readOnly={closed}
            onBlur={e => saveTextField(party, "memo", e.target.value)} className={styles.gridInput} />
        </td>
        <td style={frozenStyle(TOTAL_IDX)} className="bg-white border-b border-gray-100 text-right px-2 text-black font-medium">
          {formatComma(rowTotal(party.id))}
        </td>
        {days.map(d => {
          const key = `${party.id}:${d}`;
          return (
            <td key={d} style={{ width: DAY_W, minWidth: DAY_W }} className="border-b border-gray-100 p-0.5">
              <input
                id={`mcell-${party.id}-${d}`}
                value={formatComma(cellValues[key] ?? "")}
                readOnly={closed}
                onChange={e => updateCell(party.id, d, e.target.value)}
                onKeyDown={e => handleNav(e, party.id, String(d))}
                className={styles.gridInput + " text-right" + (saveState[key] === "saving" ? " bg-gray-100" : saveState[key] === "error" ? " ring-1 ring-red-400" : "")}
              />
            </td>
          );
        })}
        <td className="text-center border-b border-gray-100">
          {!closed && <button type="button" onClick={() => handleRemoveParty(party)} className="text-gray-300 hover:text-red-600">×</button>}
        </td>
      </tr>
    );
  }

  function renderDraftRow(direction: "in" | "out", draft: Draft, setDraft: (d: Draft) => void) {
    if (closed) return null;
    const msg = draftMsg?.dir === direction ? draftMsg.text : null;
    return (
      <tr className="bg-amber-50/40">
        <td style={frozenStyle(0)} className="bg-amber-50 px-1 py-1.5">
          <CounterpartyCell tenantId={tenantId} value={draft.name} placeholder="거래처(나중에 입력 가능)"
            onPick={(name, sid) => setDraft({ ...draft, name, supplierId: sid })} />
        </td>
        <td style={frozenStyle(1)} className="bg-amber-50 px-1">
          <CategoryCombobox
            tenantId={tenantId} categories={categories} value={draft.categoryName}
            onTextChange={text => setDraft({ ...draft, categoryName: text })}
            onPick={(id, name) => setDraft({ ...draft, categoryId: id, categoryName: name })}
            onCreated={cat => setCategories(prev => [...prev, cat])}
          />
        </td>
        <td style={frozenStyle(2)} className="bg-amber-50 px-1">
          <input value={draft.managementTag} placeholder="관리항목" onChange={e => setDraft({ ...draft, managementTag: e.target.value })} className={styles.gridInput} />
        </td>
        <td style={frozenStyle(3)} className="bg-amber-50 px-1">
          <input value={draft.bankName} placeholder="은행" onChange={e => setDraft({ ...draft, bankName: e.target.value })} className={styles.gridInput} />
        </td>
        <td style={frozenStyle(4)} className="bg-amber-50 px-1">
          <input value={draft.accountNumber} placeholder="계좌번호" onChange={e => setDraft({ ...draft, accountNumber: e.target.value })} className={styles.gridInput} />
        </td>
        <td style={frozenStyle(5)} className="bg-amber-50 px-1">
          <input value={draft.evidenceType} placeholder="증빙" onChange={e => setDraft({ ...draft, evidenceType: e.target.value })} className={styles.gridInput} />
        </td>
        <td style={frozenStyle(6)} className="bg-amber-50 px-1">
          <input
            value={draft.memo}
            placeholder="성격 메모(예: 정산금) — Enter로 행 생성"
            onChange={e => setDraft({ ...draft, memo: e.target.value })}
            onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); finalizeDraft(direction, draft, setDraft); } }}
            className={styles.gridInput + " ring-1 ring-inset ring-amber-300"}
          />
        </td>
        <td style={frozenStyle(TOTAL_IDX)} className="bg-amber-50"></td>
        <td colSpan={days.length} className="px-2 text-xs text-amber-700">
          {draftBusy === direction ? "저장 중…" : msg}
        </td>
        <td></td>
      </tr>
    );
  }

  return (
    <div>
      <div className="flex items-center gap-3 mb-2">
        <button type="button" className={styles.btnSmallGhost} onClick={() => setAnchor(a => new Date(a.getFullYear(), a.getMonth() - 1, 1))}>‹</button>
        <div className="text-sm font-bold text-black w-24 text-center">{label}</div>
        <button type="button" className={styles.btnSmallGhost} onClick={() => setAnchor(a => new Date(a.getFullYear(), a.getMonth() + 1, 1))}>›</button>
        {closed ? (
          <>
            <span className={styles.badge + " bg-gray-100 text-gray-600"}>마감됨{closedAt ? ` (${new Date(closedAt).toLocaleDateString("ko-KR")})` : ""}</span>
            <button type="button" onClick={handleReopen} className={styles.btnSmallGhost}>마감 취소</button>
          </>
        ) : (
          <button type="button" onClick={handleClose} className={styles.btnPrimary}>이 달 마감</button>
        )}
        <button type="button" onClick={() => setAnchorForm(o => !o)} className={styles.btnSmallGhost + " ml-auto"}>통장 기준잔액 설정</button>
      </div>
      {anchorForm && (
        <div className={styles.cardSm + " mb-3 flex items-center gap-2"}>
          <span className="text-xs text-gray-500">이 날짜의</span>
          <input type="date" value={anchorDate} onChange={e => setAnchorDate(e.target.value)} className={styles.inputSm} />
          <span className="text-xs text-gray-500">실제 통장 잔액</span>
          <input value={formatComma(anchorAmount)} onChange={e => setAnchorAmount(parseDigits(e.target.value))} className={styles.inputSm + " text-right w-32"} placeholder="금액" />
          <button type="button" onClick={handleSaveAnchor} className={styles.btnPrimary}>저장</button>
          <span className="text-xs text-gray-400">이후 모든 달의 기초/기말잔액이 이 기준으로 재계산돼요</span>
        </div>
      )}
      {closeErr && <div className={styles.msgError + " mb-3"}>{closeErr}</div>}
      {openingBalance === null && (
        <div className={styles.msgWarn + " mb-3"}>통장 기준잔액이 아직 설정 안 됐어요 — &quot;통장 기준잔액 설정&quot;에서 아무 날짜의 실제 통장 잔액을 한 번 입력해주세요. 그래야 기초/기말잔액이 표시돼요.</div>
      )}

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
              <tr className="bg-white">
                <td style={{ position: "sticky", left: 0, width: frozenLeft(TOTAL_IDX), zIndex: 2 }} colSpan={TOTAL_IDX}
                  className="bg-white px-2 py-1 font-medium text-gray-600">기초잔액</td>
                <td style={frozenStyle(TOTAL_IDX)} className="bg-white text-right px-2 font-bold text-gray-700">
                  {openingBalance !== null ? formatComma(openingBalance) : "-"}
                </td>
                {days.map(d => (
                  <td key={d} style={{ width: DAY_W, minWidth: DAY_W }} className="text-right px-1 text-gray-500">
                    {dailyOpeningFor(d) !== null ? formatComma(dailyOpeningFor(d) as number) : ""}
                  </td>
                ))}
                <td></td>
              </tr>
              <tr className="bg-white border-b-2 border-gray-300">
                <td style={{ position: "sticky", left: 0, width: frozenLeft(TOTAL_IDX), zIndex: 2 }} colSpan={TOTAL_IDX}
                  className="bg-white px-2 py-1 font-medium text-gray-600">기말잔액</td>
                <td style={frozenStyle(TOTAL_IDX)} className="bg-white text-right px-2 font-bold text-gray-700">
                  {monthEndClosing !== null ? formatComma(monthEndClosing) : "-"}
                </td>
                {days.map(d => (
                  <td key={d} style={{ width: DAY_W, minWidth: DAY_W }} className="text-right px-1 text-gray-500">
                    {dailyClosing[d] !== undefined ? formatComma(dailyClosing[d]) : ""}
                  </td>
                ))}
                <td></td>
              </tr>

              <tr className="bg-green-50/60">
                <td style={{ position: "sticky", left: 0, width: frozenLeft(TOTAL_IDX) + FROZEN[TOTAL_IDX].width, zIndex: 2 }} colSpan={FROZEN.length}
                  className="bg-green-50 px-2 py-1 text-sm font-bold text-green-700">입금</td>
                <td colSpan={days.length + 1}></td>
              </tr>
              {inParties.map(renderPartyRow)}
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
              {outParties.map(renderPartyRow)}
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
