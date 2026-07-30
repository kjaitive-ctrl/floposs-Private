"use client";

// 전표 화면 — 입출금 매트릭스에서 자동생성된 전표(읽기 위주) + 현금 흐름
// 없는 회계처리(계상: 선급금 등)를 위해 수동으로 만드는 전표가 한 화면에
// 같이 보임. 매트릭스와 달리 날짜×행 그리드가 아니라 전표 목록 — 계상은
// 전표마다 차변/대변 계정이 매번 달라져서 고정 칸 구조에 안 맞기 때문.
// 마이그 229.
import { useCallback, useEffect, useState } from "react";
import { styles } from "@/common/styles";
import { formatComma, parseDigits } from "@/lib/format";
import AccountCombobox from "@/components/accounting/AccountCombobox";
import CounterpartyCombobox from "@/components/accounting/CounterpartyCombobox";
import {
  type Account, type Counterparty, type JournalEntry, type ManualJournalLineInput,
  loadAccounts, loadCounterparties, loadJournalEntries, createManualJournalEntry, deleteManualJournalEntry,
} from "@/lib/accounting";

interface DraftLine {
  account_id: string;
  account_name: string;
  counterparty_id: string;
  counterparty_name: string;
  debit: string;
  credit: string;
}

function blankLine(): DraftLine {
  return { account_id: "", account_name: "", counterparty_id: "", counterparty_name: "", debit: "", credit: "" };
}

export default function JournalPanel({ tenantId, fromIso, toIso, label }: { tenantId: string; fromIso: string; toIso: string; label: string }) {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [counterparties, setCounterparties] = useState<Counterparty[]>([]);
  const [entries, setEntries] = useState<JournalEntry[]>([]);
  const [loading, setLoading] = useState(true);

  const [drafting, setDrafting] = useState(false);
  const [draftDate, setDraftDate] = useState(() => new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Seoul" }));
  const [draftMemo, setDraftMemo] = useState("");
  const [draftLines, setDraftLines] = useState<DraftLine[]>([blankLine(), blankLine()]);
  const [draftErr, setDraftErr] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const loadAll = useCallback(async () => {
    setLoading(true);
    const [accs, cps, list] = await Promise.all([
      loadAccounts(tenantId, { includeSystem: true }),
      loadCounterparties(tenantId),
      loadJournalEntries(tenantId, fromIso, toIso),
    ]);
    setAccounts(accs);
    setCounterparties(cps);
    setEntries(list);
    setLoading(false);
  }, [tenantId, fromIso, toIso]);
  useEffect(() => { loadAll(); }, [loadAll]);

  const debitSum = draftLines.reduce((s, l) => s + Number(parseDigits(l.debit) || "0"), 0);
  const creditSum = draftLines.reduce((s, l) => s + Number(parseDigits(l.credit) || "0"), 0);
  const balanced = debitSum === creditSum && debitSum > 0;

  function patchLine(i: number, patch: Partial<DraftLine>) {
    setDraftLines(prev => prev.map((l, idx) => idx === i ? { ...l, ...patch } : l));
  }

  function resetDraft() {
    setDraftDate(new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Seoul" }));
    setDraftMemo("");
    setDraftLines([blankLine(), blankLine()]);
    setDraftErr(null);
  }

  async function handleSaveDraft() {
    setDraftErr(null);
    const lines: ManualJournalLineInput[] = draftLines
      .filter(l => l.account_id && (Number(parseDigits(l.debit) || "0") > 0 || Number(parseDigits(l.credit) || "0") > 0))
      .map(l => ({
        account_id: l.account_id,
        counterparty_id: l.counterparty_id || null,
        debit_amount: Number(parseDigits(l.debit) || "0"),
        credit_amount: Number(parseDigits(l.credit) || "0"),
      }));
    if (lines.length < 2) { setDraftErr("계정이 배정된 줄이 최소 2개 필요해요."); return; }
    if (lines.some(l => l.debit_amount > 0 && l.credit_amount > 0)) { setDraftErr("한 줄에 차변/대변을 동시에 넣을 수 없어요."); return; }
    const sumDebit = lines.reduce((s, l) => s + l.debit_amount, 0);
    const sumCredit = lines.reduce((s, l) => s + l.credit_amount, 0);
    if (sumDebit !== sumCredit) { setDraftErr(`차변 합(${formatComma(sumDebit)})과 대변 합(${formatComma(sumCredit)})이 일치해야 해요.`); return; }

    setSaving(true);
    const { error } = await createManualJournalEntry(tenantId, draftDate, draftMemo, lines);
    setSaving(false);
    if (error) { setDraftErr(error); return; }
    setDrafting(false);
    resetDraft();
    loadAll();
  }

  async function handleDelete(entry: JournalEntry) {
    if (!confirm(`전표 #${entry.entry_no}를 지울까요?`)) return;
    const { error } = await deleteManualJournalEntry(entry.id);
    if (error) { alert(error); return; }
    setEntries(prev => prev.filter(e => e.id !== entry.id));
  }

  return (
    <div className={styles.cardSm}>
      <div className={styles.sectionLabel}>전표 ({label}, {entries.length}건)</div>

      {loading ? (
        <div className="text-xs text-gray-400">불러오는 중…</div>
      ) : (
        <>
              <table className="w-full text-xs mb-3">
                <thead>
                  <tr>
                    <th className={styles.th}>번호</th>
                    <th className={styles.th}>날짜</th>
                    <th className={styles.thLeft}>적요</th>
                    <th className={styles.thLeft}>라인</th>
                    <th className={styles.th}>출처</th>
                    <th className={styles.th}></th>
                  </tr>
                </thead>
                <tbody>
                  {entries.length === 0 && (
                    <tr><td colSpan={6} className="text-center text-gray-400 py-4 text-xs">이번 달 전표가 없어요.</td></tr>
                  )}
                  {entries.map(e => (
                    <tr key={e.id} className={styles.tr}>
                      <td className={styles.tdCenter}>{e.entry_no}</td>
                      <td className={styles.tdCenter}>{e.entry_date.slice(5)}</td>
                      <td className={styles.tdText}>{e.memo || "-"}</td>
                      <td className={styles.tdText}>
                        {e.lines.map(l => (
                          <div key={l.id}>
                            {l.account?.name ?? "?"}{l.counterparty ? `(${l.counterparty.name})` : ""} —{" "}
                            {l.debit_amount > 0 ? `차변 ${formatComma(l.debit_amount)}` : `대변 ${formatComma(l.credit_amount)}`}
                          </div>
                        ))}
                      </td>
                      <td className={styles.tdCenter}>
                        <span className={styles.badge + " " + (e.source_cash_entry_id ? styles.badgeRegistered : styles.badgeSample)}>
                          {e.source_cash_entry_id ? "자동" : "수동"}
                        </span>
                      </td>
                      <td className={styles.tdCenter}>
                        {!e.source_cash_entry_id && (
                          <button type="button" onClick={() => handleDelete(e)} className="text-gray-400 hover:text-red-600">삭제</button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>

              {!drafting ? (
                <button type="button" onClick={() => setDrafting(true)} className={styles.btnSmallGhost}>+ 전표 추가 (현금 흐름 없는 계상 등)</button>
              ) : (
                <div className="border border-gray-200 rounded-lg p-3 space-y-2">
                  <div className="flex items-center gap-2">
                    <input type="date" value={draftDate} onChange={e => setDraftDate(e.target.value)} className={styles.inputSm} />
                    <input value={draftMemo} onChange={e => setDraftMemo(e.target.value)} placeholder="적요" className={styles.inputSm + " flex-1"} />
                  </div>
                  <table className="w-full text-xs">
                    <thead>
                      <tr>
                        <th className={styles.thLeft}>계정</th>
                        <th className={styles.thLeft}>거래처(선택)</th>
                        <th className={styles.th}>차변</th>
                        <th className={styles.th}>대변</th>
                        <th className={styles.th}></th>
                      </tr>
                    </thead>
                    <tbody>
                      {draftLines.map((l, i) => (
                        <tr key={i} className={styles.tr}>
                          <td className="px-1 py-1">
                            <AccountCombobox
                              tenantId={tenantId} accounts={accounts} value={l.account_name}
                              defaultGubunForNew="판관비"
                              onTextChange={text => patchLine(i, { account_name: text })}
                              onPick={(id, name) => patchLine(i, { account_id: id, account_name: name })}
                              onCreated={acc => setAccounts(prev => [...prev, acc])}
                            />
                          </td>
                          <td className="px-1 py-1">
                            <CounterpartyCombobox
                              tenantId={tenantId} counterparties={counterparties} value={l.counterparty_name}
                              onTextChange={text => patchLine(i, { counterparty_name: text })}
                              onPick={(id, name) => patchLine(i, { counterparty_id: id, counterparty_name: name })}
                              onCreated={cp => setCounterparties(prev => [...prev, cp])}
                            />
                          </td>
                          <td className="px-1 py-1">
                            <input value={formatComma(l.debit)} onChange={e => patchLine(i, { debit: parseDigits(e.target.value) })}
                              className={styles.gridInput + " text-right"} placeholder="0" />
                          </td>
                          <td className="px-1 py-1">
                            <input value={formatComma(l.credit)} onChange={e => patchLine(i, { credit: parseDigits(e.target.value) })}
                              className={styles.gridInput + " text-right"} placeholder="0" />
                          </td>
                          <td className="px-1 py-1 text-center">
                            {draftLines.length > 2 && (
                              <button type="button" onClick={() => setDraftLines(prev => prev.filter((_, idx) => idx !== i))}
                                className="text-gray-300 hover:text-red-600">×</button>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <div className="flex items-center gap-3">
                    <button type="button" onClick={() => setDraftLines(prev => [...prev, blankLine()])} className={styles.btnSmallGhost}>+ 줄 추가</button>
                    <span className={"text-xs " + (balanced ? "text-emerald-600" : "text-gray-400")}>
                      차변 {formatComma(debitSum)} / 대변 {formatComma(creditSum)} {balanced ? "· 일치" : ""}
                    </span>
                  </div>
                  {draftErr && <div className={styles.msgError}>{draftErr}</div>}
                  <div className="flex gap-2">
                    <button type="button" onClick={handleSaveDraft} disabled={saving || !balanced} className={styles.btnPrimary}>
                      {saving ? "저장 중…" : "저장"}
                    </button>
                    <button type="button" onClick={() => { setDrafting(false); resetDraft(); }} className={styles.btnSecondary}>취소</button>
                  </div>
                </div>
              )}
            </>
          )}
    </div>
  );
}
