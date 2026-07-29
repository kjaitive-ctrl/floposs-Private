"use client";

// 거래처 입력 — 타이핑 후 매칭/생성(계정과목과 같은 결). 예금주/은행/계좌번호는
// 거래처 레코드에 속함 — 여기선 이름만 다루고, 나머지는 행에서 별도로 편집.
import { useState, type KeyboardEvent } from "react";
import { styles } from "@/common/styles";
import { type Counterparty, addCounterparty } from "@/lib/accounting";

interface Props {
  id?: string;
  tenantId: string;
  counterparties: Counterparty[];
  value: string;
  onTextChange: (text: string) => void;
  onPick: (counterpartyId: string, name: string) => void;
  onCreated?: (cp: Counterparty) => void;
  onKeyDownNav?: (e: KeyboardEvent<HTMLInputElement>) => void;
}

export default function CounterpartyCombobox({
  id, tenantId, counterparties, value, onTextChange, onPick, onCreated, onKeyDownNav,
}: Props) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [busy, setBusy] = useState(false);

  const term = value.trim().toLowerCase();
  const hits = term ? counterparties.filter(c => c.name.toLowerCase().includes(term)) : counterparties;

  async function commit(hit?: Counterparty) {
    setOpen(false);
    const chosen = hit ?? counterparties.find(c => c.name.toLowerCase() === term);
    if (chosen) { onPick(chosen.id, chosen.name); return; }
    const trimmed = value.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    const created = await addCounterparty(tenantId, trimmed);
    setBusy(false);
    if (created) { onCreated?.(created); onPick(created.id, created.name); }
  }

  function handleKey(e: KeyboardEvent<HTMLInputElement>) {
    if (open && hits.length > 0) {
      if (e.key === "ArrowDown") { e.preventDefault(); setActive(a => Math.min(a + 1, hits.length - 1)); return; }
      if (e.key === "ArrowUp")   { e.preventDefault(); setActive(a => Math.max(a - 1, 0)); return; }
    }
    if (e.key === "Enter") { e.preventDefault(); commit(open && hits.length > 0 ? hits[active] : undefined); return; }
    if (e.key === "Escape") { setOpen(false); return; }
    onKeyDownNav?.(e);
  }

  return (
    <div className="relative w-full">
      <input
        id={id}
        value={value}
        placeholder="거래처 입력"
        onChange={e => { onTextChange(e.target.value); setActive(0); setOpen(true); }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => { setOpen(false); commit(); }, 150)}
        onKeyDown={handleKey}
        className={styles.gridInput}
      />
      {open && (
        <div className="absolute left-0 top-full z-30 mt-0.5 w-52 bg-white border border-gray-300 rounded-lg shadow-lg max-h-56 overflow-auto text-xs">
          {hits.map((c, i) => (
            <button key={c.id} type="button" onMouseDown={e => { e.preventDefault(); commit(c); }}
              className={`w-full text-left px-3 py-1.5 border-b border-gray-100 ${i === active ? "bg-gray-100" : "hover:bg-gray-50"}`}>
              <span className="font-medium text-black">{c.name}</span>
            </button>
          ))}
          {term && !counterparties.some(c => c.name.toLowerCase() === term) && (
            <button type="button" onMouseDown={e => { e.preventDefault(); commit(); }}
              className="w-full text-left px-3 py-2 text-primary font-medium hover:bg-gray-50">
              + &quot;{value.trim()}&quot; 새 거래처
            </button>
          )}
        </div>
      )}
    </div>
  );
}
