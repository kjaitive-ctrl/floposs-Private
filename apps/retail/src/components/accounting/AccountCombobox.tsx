"use client";

// 계정과목 입력 — 드롭다운 선택이 아니라 "타이핑 후 매칭". 기존 이름과 매칭되면
// 그 계정 재사용, 없으면 Enter/blur 시 새 계정 생성(코드는 DB가 자동 부여).
// 완전 controlled — value 는 항상 부모 state.
import { useState, type KeyboardEvent } from "react";
import { styles } from "@/common/styles";
import { type Account, type Gubun, addAccount } from "@/lib/accounting";

interface Props {
  id?: string;
  tenantId: string;
  accounts: Account[];
  value: string;
  defaultGubunForNew: Gubun;  // Enter로 신규 생성 시 기본 구분
  onTextChange: (text: string) => void;
  onPick: (accountId: string, name: string) => void;
  onCreated?: (account: Account) => void;
  onKeyDownNav?: (e: KeyboardEvent<HTMLInputElement>) => void;
}

export default function AccountCombobox({
  id, tenantId, accounts, value, defaultGubunForNew, onTextChange, onPick, onCreated, onKeyDownNav,
}: Props) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [busy, setBusy] = useState(false);

  const term = value.trim().toLowerCase();
  const hits = term ? accounts.filter(a => a.name.toLowerCase().includes(term)) : accounts;

  async function commit(hit?: Account) {
    setOpen(false);
    const chosen = hit ?? accounts.find(a => a.name.toLowerCase() === term);
    if (chosen) { onPick(chosen.id, chosen.name); return; }
    const trimmed = value.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    const created = await addAccount(tenantId, trimmed, defaultGubunForNew);
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
        placeholder="계정 입력"
        onChange={e => { onTextChange(e.target.value); setActive(0); setOpen(true); }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => { setOpen(false); commit(); }, 150)}
        onKeyDown={handleKey}
        className={styles.gridInput}
      />
      {open && (
        <div className="absolute left-0 top-full z-30 mt-0.5 w-52 bg-white border border-gray-300 rounded-lg shadow-lg max-h-56 overflow-auto text-xs">
          {hits.map((a, i) => (
            <button key={a.id} type="button" onMouseDown={e => { e.preventDefault(); commit(a); }}
              className={`w-full text-left px-3 py-1.5 border-b border-gray-100 ${i === active ? "bg-gray-100" : "hover:bg-gray-50"}`}>
              <span className="text-gray-400 mr-1">{a.code}</span>
              <span className="font-medium text-black">{a.name}</span>
            </button>
          ))}
          {term && !accounts.some(a => a.name.toLowerCase() === term) && (
            <button type="button" onMouseDown={e => { e.preventDefault(); commit(); }}
              className="w-full text-left px-3 py-2 text-primary font-medium hover:bg-gray-50">
              + &quot;{value.trim()}&quot; 새 계정 ({defaultGubunForNew})
            </button>
          )}
        </div>
      )}
    </div>
  );
}
