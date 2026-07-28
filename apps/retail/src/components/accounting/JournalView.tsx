"use client";

// 복식부기 전표 — 현금거래(마이그 221 트리거로 자동생성)와 수동전표(현금 안 오가는 것:
// 감가상각/재고조정/이월 등)를 한 화면에서 그대로 출력. 결재라인은 스코프 제외(사장님 명시).
import { useCallback, useEffect, useState } from "react";
import { styles } from "@/common/styles";
import { formatComma, parseDigits } from "@/lib/format";
import CategoryCombobox from "@/components/accounting/CategoryCombobox";
import CounterpartyCell from "@/components/accounting/CounterpartyCell";
import {
  type AccountCategory, type JournalLineRow,
  loadAccountCategories, loadJournalLines, addManualJournalEntry, deleteJournalEntry,
} from "@/lib/accounting";

function monthRange(anchor: Date): { fromIso: string; toIso: string; label: string } {
  const y = anchor.getFullYear(), m = anchor.getMonth();
  const from = new Date(y, m, 1), to = new Date(y, m + 1, 0);
  const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  return { fromIso: iso(from), toIso: iso(to), label: `${y}년 ${m + 1}월` };
}

interface LineDraft {
  key: string;
  account_category_id: string | null;
  account_name: string;
  counterparty: string;
  amount: string;
  side: "debit" | "credit";
}
function blankLine(): LineDraft {
  return { key: `${Date.now()}-${Math.random().toString(36).slice(2)}`, account_category_id: null, account_name: "", counterparty: "", amount: "", side: "debit" };
}

export default function JournalView({ tenantId }: { tenantId: string }) {
  const [anchor, setAnchor] = useState(() => new Date());
  const { fromIso, toIso, label } = monthRange(anchor);
  const [lines, setLines] = useState<JournalLineRow[]>([]);
  const [categories, setCategories] = useState<AccountCategory[]>([]);
  const [loading, setLoading] = useState(true);
  const [formOpen, setFormOpen] = useState(false);
  const [entryDate, setEntryDate] = useState(() => new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Seoul" }));
  const [entryMemo, setEntryMemo] = useState("");
  const [draftLines, setDraftLines] = useState<LineDraft[]>([blankLine(), blankLine()]);
  const [saving, setSaving] = useState(false);
  const [formErr, setFormErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    const [ls, cats] = await Promise.all([
      loadJournalLines(tenantId, fromIso, toIso),
      loadAccountCategories(tenantId, { includeSystem: true }),
    ]);
    setLines(ls);
    setCategories(cats);
    setLoading(false);
  }, [tenantId, fromIso, toIso]);
  useEffect(() => { load(); }, [load]);

  // entry_id 순서 유지하며 그룹핑 (표시는 전표 단위로 묶어서)
  const entryOrder: string[] = [];
  const byEntry = new Map<string, JournalLineRow[]>();
  for (const l of lines) {
    if (!byEntry.has(l.entry_id)) { byEntry.set(l.entry_id, []); entryOrder.push(l.entry_id); }
    byEntry.get(l.entry_id)!.push(l);
  }

  const totalDebit = lines.reduce((s, l) => s + l.debit_amount, 0);
  const totalCredit = lines.reduce((s, l) => s + l.credit_amount, 0);
  const balanced = totalDebit === totalCredit;

  function updateLine(key: string, patch: Partial<LineDraft>) {
    setDraftLines(prev => prev.map(l => l.key === key ? { ...l, ...patch } : l));
  }
  function addDraftLine() {
    setDraftLines(prev => [...prev, blankLine()]);
  }
  function removeDraftLine(key: string) {
    setDraftLines(prev => prev.length > 2 ? prev.filter(l => l.key !== key) : prev);
  }

  const draftDebit = draftLines.reduce((s, l) => s + (l.side === "debit" ? Number(l.amount || 0) : 0), 0);
  const draftCredit = draftLines.reduce((s, l) => s + (l.side === "credit" ? Number(l.amount || 0) : 0), 0);
  const draftBalanced = draftDebit > 0 && draftDebit === draftCredit;

  async function handleSaveEntry() {
    setFormErr(null);
    if (!draftBalanced) { setFormErr("차변 합계와 대변 합계가 같아야 저장할 수 있어요."); return; }
    const missing = draftLines.some(l => Number(l.amount || 0) > 0 && !l.account_category_id);
    if (missing) { setFormErr("금액을 입력한 줄은 계정과목을 확정해야 해요(Enter로 매칭/생성)."); return; }
    setSaving(true);
    const ok = await addManualJournalEntry(
      tenantId, entryDate, entryMemo || null,
      draftLines.filter(l => Number(l.amount || 0) > 0).map(l => ({
        account_category_id: l.account_category_id!,
        counterparty_name: l.counterparty || null,
        debit_amount: l.side === "debit" ? Number(l.amount) : 0,
        credit_amount: l.side === "credit" ? Number(l.amount) : 0,
      }))
    );
    setSaving(false);
    if (!ok) { setFormErr("저장 실패 — 다시 시도해주세요."); return; }
    setFormOpen(false);
    setEntryMemo("");
    setDraftLines([blankLine(), blankLine()]);
    load();
  }

  async function handleDeleteEntry(entryId: string) {
    if (!confirm("이 수동전표를 삭제할까요?")) return;
    await deleteJournalEntry(entryId);
    load();
  }

  return (
    <div>
      <div className="flex items-center gap-3 mb-4">
        <button type="button" className={styles.btnSmallGhost} onClick={() => setAnchor(a => new Date(a.getFullYear(), a.getMonth() - 1, 1))}>‹</button>
        <div className="text-sm font-bold text-black w-24 text-center">{label}</div>
        <button type="button" className={styles.btnSmallGhost} onClick={() => setAnchor(a => new Date(a.getFullYear(), a.getMonth() + 1, 1))}>›</button>
        <button type="button" className={styles.btnPrimary + " ml-2"} onClick={() => setFormOpen(o => !o)}>+ 수동전표 (현금 안 오가는 거래)</button>
        <div className="ml-auto text-xs">
          <span className="text-gray-500">차변 {formatComma(totalDebit)} · 대변 {formatComma(totalCredit)}</span>
          <span className={"ml-2 font-medium " + (balanced ? "text-green-600" : "text-red-600")}>{balanced ? "✓ 균형" : "✗ 불일치"}</span>
        </div>
      </div>

      {formOpen && (
        <div className={styles.card + " mb-4"}>
          <div className="flex items-center gap-2 mb-3">
            <input type="date" value={entryDate} onChange={e => setEntryDate(e.target.value)} className={styles.inputMd + " w-40"} />
            <input placeholder="적요" value={entryMemo} onChange={e => setEntryMemo(e.target.value)} className={styles.inputMd + " flex-1"} />
          </div>
          <table className="w-full text-xs mb-2">
            <thead>
              <tr>
                <th className={styles.th + " w-40"}>계정과목</th>
                <th className={styles.thLeft}>거래처</th>
                <th className={styles.th + " w-32"}>금액</th>
                <th className={styles.th + " w-24"}>차변/대변</th>
                <th className={styles.th + " w-8"}></th>
              </tr>
            </thead>
            <tbody>
              {draftLines.map(l => (
                <tr key={l.key} className={styles.tr}>
                  <td className={styles.tdCenter}>
                    <CategoryCombobox
                      tenantId={tenantId}
                      categories={categories}
                      value={l.account_name}
                      defaultTypeForNew="자본거래"
                      onTextChange={text => updateLine(l.key, { account_name: text })}
                      onPick={(id, name) => updateLine(l.key, { account_category_id: id, account_name: name })}
                      onCreated={cat => setCategories(prev => [...prev, cat])}
                    />
                  </td>
                  <td className={styles.tdText}>
                    <CounterpartyCell tenantId={tenantId} value={l.counterparty} onPick={name => updateLine(l.key, { counterparty: name })} />
                  </td>
                  <td className={styles.tdText}>
                    <input value={formatComma(l.amount)} onChange={e => updateLine(l.key, { amount: parseDigits(e.target.value) })}
                      className={styles.gridInput + " text-right"} />
                  </td>
                  <td className={styles.tdCenter}>
                    <button type="button" onClick={() => updateLine(l.key, { side: l.side === "debit" ? "credit" : "debit" })}
                      className={styles.badge + " " + (l.side === "debit" ? "bg-blue-50 text-blue-700" : "bg-amber-50 text-amber-700")}>
                      {l.side === "debit" ? "차변" : "대변"}
                    </button>
                  </td>
                  <td className={styles.tdCenter}>
                    <button type="button" onClick={() => removeDraftLine(l.key)} className="text-gray-300 hover:text-red-600">×</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="flex items-center gap-3">
            <button type="button" onClick={addDraftLine} className={styles.btnSmallGhost}>+ 줄 추가</button>
            <span className="text-xs text-gray-500">차변 {formatComma(draftDebit)} · 대변 {formatComma(draftCredit)}</span>
            <span className={"text-xs font-medium " + (draftBalanced ? "text-green-600" : "text-red-600")}>{draftBalanced ? "✓ 균형" : "✗ 불일치"}</span>
            <button type="button" disabled={!draftBalanced || saving} onClick={handleSaveEntry} className={styles.btnPrimary + " ml-auto"}>
              {saving ? "저장 중…" : "전표 저장"}
            </button>
          </div>
          {formErr && <div className={styles.msgError + " mt-2"}>{formErr}</div>}
        </div>
      )}

      {loading ? (
        <div className="text-xs text-gray-400">불러오는 중…</div>
      ) : lines.length === 0 ? (
        <div className="text-xs text-gray-400">이 달 전표가 없어요.</div>
      ) : (
        <div className="border border-gray-200 rounded-lg overflow-hidden">
          <table className="w-full text-xs">
            <thead>
              <tr className="bg-gray-50">
                <th className={styles.th + " w-24"}>회계일</th>
                <th className={styles.thLeft + " w-40"}>계정</th>
                <th className={styles.th + " w-16"}>구분</th>
                <th className={styles.thLeft}>거래처</th>
                <th className={styles.th + " w-28"}>차변</th>
                <th className={styles.th + " w-28"}>대변</th>
                <th className={styles.thLeft}>적요</th>
                <th className={styles.th + " w-10"}></th>
              </tr>
            </thead>
            <tbody>
              {entryOrder.map(entryId => {
                const group = byEntry.get(entryId)!;
                return group.map((l, i) => (
                  <tr key={l.id} className={styles.tr + (i === 0 ? " border-t-2 border-gray-200" : "")}>
                    <td className={styles.tdCenter}>{i === 0 ? l.entry_date : ""}</td>
                    <td className={styles.tdText}>{l.account_name}</td>
                    <td className={styles.tdCenter + " text-gray-400"}>{l.gubun}</td>
                    <td className={styles.tdText}>{l.counterparty_name}</td>
                    <td className={styles.tdRight}>{l.debit_amount > 0 ? formatComma(l.debit_amount) : ""}</td>
                    <td className={styles.tdRight}>{l.credit_amount > 0 ? formatComma(l.credit_amount) : ""}</td>
                    <td className={styles.tdText + " text-gray-400"}>{i === 0 ? l.memo : ""}</td>
                    <td className={styles.tdCenter}>
                      {i === 0 && l.is_manual && (
                        <button type="button" onClick={() => handleDeleteEntry(entryId)} className="text-gray-300 hover:text-red-600">×</button>
                      )}
                    </td>
                  </tr>
                ));
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
