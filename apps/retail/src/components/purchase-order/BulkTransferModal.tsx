"use client";

// 국민은행 대량이체 엑셀 만들기 (뼈대) — 주문일 범위의 입고분을 거래처별로 합산.
// 계좌는 회계 거래처(이름이 같은 것)에서 가져오고, 없으면 여기서 적음. 여기서 적은 값은 저장되지 않음.
import { useEffect, useMemo, useState } from "react";
import { styles } from "@/common/styles";
import { formatComma, parseDigits } from "@/lib/format";
import { loadCounterparties, type Counterparty } from "@/lib/accounting";
import type { OrderItem } from "@/lib/purchaseOrder";
import { BANK_NAMES, bankCode, downloadTransferFile, groupReceived } from "@/lib/kbTransfer";

interface Edit { bank?: string; account?: string; holder?: string; amount?: number; off?: boolean }

interface Props {
  tenantId: string;
  items: OrderItem[];
  initialDate: string;
  orderDate: (value: string) => string; // created_at → 한국 날짜
  senderName: string;
  onClose: () => void;
}

export default function BulkTransferModal({ tenantId, items, initialDate, orderDate, senderName, onClose }: Props) {
  const [from, setFrom] = useState(initialDate);
  const [to, setTo] = useState(initialDate);
  const [includeSamples, setIncludeSamples] = useState(false);
  const [receiverMemo, setReceiverMemo] = useState(senderName.slice(0, 10));
  const [counterparties, setCounterparties] = useState<Counterparty[] | null>(null);
  const [edits, setEdits] = useState<Record<string, Edit>>({});
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    loadCounterparties(tenantId).then(list => { if (alive) setCounterparties(list); });
    return () => { alive = false; };
  }, [tenantId]);

  const rows = useMemo(() => {
    const targets = items.filter(i => { const d = orderDate(i.created_at); return d >= from && d <= to; });
    return groupReceived(targets, includeSamples).map(g => {
      const cp = counterparties?.find(c => c.name.trim() === g.supplier);
      const e = edits[g.supplier] ?? {};
      const bank = e.bank ?? cp?.bank_name ?? "";
      const account = e.account ?? cp?.account_number ?? "";
      const holder = e.holder ?? cp?.account_holder ?? "";
      const amount = e.amount ?? g.amount;
      const code = bankCode(bank);
      const problems = [
        !bank.trim() ? "은행 없음" : !code ? "은행 확인" : "",
        !account.trim() ? "계좌 없음" : account.replace(/[^0-9]/g, "").length < 7 ? "계좌 확인" : "",
        g.noPrice > 0 && e.amount === undefined ? `단가 없음 ${g.noPrice}줄` : "",
        !Number.isInteger(amount) || amount <= 0 ? "금액 확인" : "",
      ].filter(Boolean);
      return { ...g, bank, account, holder, amount, code, problems, off: !!e.off };
    });
  }, [items, orderDate, from, to, includeSamples, counterparties, edits]);

  const ready = rows.filter(r => !r.off && r.problems.length === 0);
  const blocked = rows.filter(r => !r.off && r.problems.length > 0);
  const total = ready.reduce((sum, r) => sum + r.amount, 0);

  function edit(supplier: string, patch: Edit) {
    setMsg(null);
    setEdits(prev => ({ ...prev, [supplier]: { ...prev[supplier], ...patch } }));
  }

  // 대상이 바뀌면 손으로 고친 금액은 더 이상 맞지 않으므로 지움 (계좌는 유지)
  function changeScope(apply: () => void) {
    setMsg(null);
    setEdits(prev => Object.fromEntries(Object.entries(prev).map(([k, e]) => [k, { ...e, amount: undefined }])));
    apply();
  }

  function handleDownload() {
    if (ready.length === 0) return;
    if (blocked.length > 0 && !confirm(`확인이 필요한 거래처 ${blocked.length}곳은 빠집니다. ${ready.length}곳만 만들까요?`)) return;
    try {
      downloadTransferFile(ready.map(r => ({
        code: r.code ?? "", account: r.account, amount: r.amount, holder: r.holder, receiverMemo, senderMemo: r.supplier,
      })), from === to ? from : `${from}_${to}`);
      setMsg(`내려받음: ${ready.length}곳 ${formatComma(total)}원`);
    } catch (e) {
      setMsg(`만들기 실패: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  return (
    <div className={styles.modalOverlay} onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className={styles.modalContent + " !max-w-6xl"}>
        <div className={styles.modalHeader + " flex items-center gap-3"}>
          <h2 className="text-base font-bold text-black">국민은행 대량이체 엑셀</h2>
          <button type="button" onClick={onClose} className="ml-auto text-gray-400 hover:text-black">✕</button>
        </div>

        <div className={styles.modalBody}>
          <div className="flex flex-wrap items-center gap-3 text-xs text-black">
            <label className="flex items-center gap-1">주문일
              <input type="date" aria-label="주문일 시작" value={from} max={to} onChange={e => { const v = e.target.value; if (v) changeScope(() => setFrom(v)); }} className={styles.inputSm} />
            </label>
            <span>~</span>
            <input type="date" aria-label="주문일 끝" value={to} min={from} onChange={e => { const v = e.target.value; if (v) changeScope(() => setTo(v)); }} className={styles.inputSm} />
            <label className="flex items-center gap-1">
              <input type="checkbox" checked={includeSamples} onChange={e => { const v = e.target.checked; changeScope(() => setIncludeSamples(v)); }} />
              샘플요청 포함
            </label>
            <label className="flex items-center gap-1">받는 분 통장 표시
              <input value={receiverMemo} maxLength={10} onChange={e => setReceiverMemo(e.target.value)} className={styles.inputSm + " w-32"} />
            </label>
          </div>
          <div className={styles.msgWarn}>
            송금 여부는 아직 기록하지 않습니다. 이미 보낸 주문이 섞이지 않았는지 확인하세요. 여기서 적은 계좌·금액은 저장되지 않고, 반품·교환은 자동으로 빼지 않습니다.
          </div>
          {rows.length === 0 ? (
            <div className="text-xs text-gray-500">이 기간에 입고·즉시출고된 이체 주문이 없습니다.</div>
          ) : (
            <div className="overflow-x-auto border border-gray-200 rounded-lg">
              <datalist id="kb-bank-names">{BANK_NAMES.map(n => <option key={n} value={n} />)}</datalist>
              <table className="w-full min-w-[960px] table-fixed text-xs border-collapse">
                <colgroup>
                  <col className="w-10" /><col className="w-36" /><col className="w-16" /><col className="w-28" /><col className="w-28" />
                  <col className="w-14" /><col className="w-40" /><col className="w-28" /><col />
                </colgroup>
                <thead>
                  <tr className="bg-gray-50">
                    {["", "거래처", "입고", "금액", "은행", "코드", "계좌번호", "예금주", "확인"].map(h => (
                      <th key={h} className="px-2 py-2 text-left text-black font-medium whitespace-nowrap">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.map(r => (
                    <tr key={r.supplier} className={"border-t border-gray-100" + (r.off ? " opacity-40" : r.problems.length ? " bg-red-50/40" : "")}>
                      <td className="px-2 py-1 text-center">
                        <input type="checkbox" aria-label={`${r.supplier} 포함`} checked={!r.off} onChange={e => edit(r.supplier, { off: !e.target.checked })} />
                      </td>
                      <td className="px-2 py-1 text-black truncate" title={r.supplier}>{r.supplier}</td>
                      <td className="px-2 py-1 text-right text-gray-600 tabular-nums">{r.quantity}장</td>
                      <td className="px-1 py-1">
                        <input aria-label={`${r.supplier} 금액`} value={formatComma(r.amount)}
                          onChange={e => edit(r.supplier, { amount: Number(parseDigits(e.target.value) || "0") })}
                          className={styles.gridInput + " text-right tabular-nums"} />
                      </td>
                      <td className="px-1 py-1">
                        <input aria-label={`${r.supplier} 은행`} list="kb-bank-names" value={r.bank} placeholder="은행"
                          onChange={e => edit(r.supplier, { bank: e.target.value })} className={styles.gridInput} />
                      </td>
                      <td className="px-2 py-1 text-gray-600 tabular-nums">{r.code ?? ""}</td>
                      <td className="px-1 py-1">
                        <input aria-label={`${r.supplier} 계좌번호`} value={r.account} placeholder="계좌번호"
                          onChange={e => edit(r.supplier, { account: e.target.value })} className={styles.gridInput} />
                      </td>
                      <td className="px-1 py-1">
                        <input aria-label={`${r.supplier} 예금주`} value={r.holder} placeholder="예금주"
                          onChange={e => edit(r.supplier, { holder: e.target.value })} className={styles.gridInput} />
                      </td>
                      <td className="px-2 py-1">
                        <span className="text-red-600">{r.problems.join(" · ")}</span>
                        {r.claims > 0 && <span className="text-amber-700">{r.problems.length ? " · " : ""}반품·교환 {r.claims}줄</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <div className={styles.modalFooter + " items-center"}>
          <span className="text-xs text-gray-600">
            {counterparties === null ? "계좌 불러오는 중…" : <>엑셀 <b className="text-black">{ready.length}곳 {formatComma(total)}원</b></>}
            {counterparties !== null && blocked.length > 0 && <> · <span className="text-red-600">확인 필요 {blocked.length}곳</span></>}
            {msg && <> · <span role="status" className="text-black">{msg}</span></>}
          </span>
          <button type="button" onClick={onClose} className={styles.btnSecondary + " ml-auto"}>닫기</button>
          <button type="button" onClick={handleDownload} disabled={counterparties === null || ready.length === 0} className={styles.btnPrimary}>엑셀 내려받기</button>
        </div>
      </div>
    </div>
  );
}
