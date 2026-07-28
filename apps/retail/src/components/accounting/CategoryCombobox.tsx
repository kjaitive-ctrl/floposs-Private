"use client";

// 계정과목 입력 — 드롭다운 선택이 아니라 "타이핑 후 매칭"(SupplierAutocomplete 와 같은 결).
// 기존 이름과 매칭되면 그 계정 재사용, 없으면 Enter/blur 시 새 계정과목 즉시 생성.
// 마우스 없이 Tab/↑↓/Enter 만으로 완결. 완전 controlled — value 는 항상 부모 state.
import { useState, type KeyboardEvent } from "react";
import { styles } from "@/common/styles";
import { type AccountCategory, type AccountType, addAccountCategory } from "@/lib/accounting";

interface Props {
  id?: string;
  tenantId: string;
  categories: AccountCategory[];
  value: string;                    // 표시 텍스트(계정과목 이름) — 부모 state
  defaultTypeForNew?: AccountType;  // Enter로 신규 생성 시 기본 성격 (미지정 시 판관비)
  onTextChange: (text: string) => void;       // 타이핑 = free text (아직 미확정)
  onPick: (categoryId: string, name: string) => void;  // 매칭/생성 확정
  onCreated?: (cat: AccountCategory) => void;
  onKeyDownNav?: (e: KeyboardEvent<HTMLInputElement>) => void;
}

export default function CategoryCombobox({
  id, tenantId, categories, value, defaultTypeForNew = "판관비",
  onTextChange, onPick, onCreated, onKeyDownNav,
}: Props) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [busy, setBusy] = useState(false);

  const term = value.trim().toLowerCase();
  const hits = term ? categories.filter(c => c.name.toLowerCase().includes(term)) : categories;

  async function commit(hit?: AccountCategory) {
    setOpen(false);
    const chosen = hit ?? categories.find(c => c.name.toLowerCase() === term);
    if (chosen) { onPick(chosen.id, chosen.name); return; }
    const trimmed = value.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    const created = await addAccountCategory(tenantId, trimmed, defaultTypeForNew);
    setBusy(false);
    if (created) {
      onCreated?.(created);
      onPick(created.id, created.name);
    }
  }

  function handleKey(e: KeyboardEvent<HTMLInputElement>) {
    if (open && hits.length > 0) {
      if (e.key === "ArrowDown") { e.preventDefault(); setActive(a => Math.min(a + 1, hits.length - 1)); return; }
      if (e.key === "ArrowUp")   { e.preventDefault(); setActive(a => Math.max(a - 1, 0)); return; }
    }
    if (e.key === "Enter") {
      e.preventDefault();
      commit(open && hits.length > 0 ? hits[active] : undefined);
      return;
    }
    if (e.key === "Escape") { setOpen(false); return; }
    onKeyDownNav?.(e);
  }

  return (
    <div className="relative w-full">
      <input
        id={id}
        value={value}
        placeholder="계정과목 입력"
        onChange={e => { onTextChange(e.target.value); setActive(0); setOpen(true); }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => { setOpen(false); commit(); }, 150)}
        onKeyDown={handleKey}
        className={styles.gridInput}
      />
      {open && (
        <div className="absolute left-0 top-full z-30 mt-0.5 w-48 bg-white border border-gray-300 rounded-lg shadow-lg max-h-56 overflow-auto text-xs">
          {hits.map((c, i) => (
            <button key={c.id} type="button" onMouseDown={e => { e.preventDefault(); commit(c); }}
              className={`w-full text-left px-3 py-1.5 border-b border-gray-100 ${i === active ? "bg-gray-100" : "hover:bg-gray-50"}`}>
              <span className="font-medium text-black">{c.name}</span>
              <span className="ml-2 text-gray-400">{c.type}</span>
            </button>
          ))}
          {term && !categories.some(c => c.name.toLowerCase() === term) && (
            <button type="button" onMouseDown={e => { e.preventDefault(); commit(); }}
              className="w-full text-left px-3 py-2 text-primary font-medium hover:bg-gray-50">
              + &quot;{value.trim()}&quot; 새 계정과목 ({defaultTypeForNew})
            </button>
          )}
        </div>
      )}
    </div>
  );
}
