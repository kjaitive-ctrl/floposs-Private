"use client";

// 거래처 입력 — 타이핑 후 매칭/생성(계정과목과 같은 결). 예금주/은행/계좌번호는
// 거래처 레코드에 속함 — 여기선 이름만 다루고, 나머지는 행에서 별도로 편집.
// 드롭다운은 document.body 로 포탈 — AccountCombobox 와 동일한 이유(overflow-x-auto
// 매트릭스 컨테이너 안이라 absolute 드롭다운이 잘림).
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
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
  const [rect, setRect] = useState<{ top: number; left: number; width: number } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const term = value.trim().toLowerCase();
  const hits = term ? counterparties.filter(c => c.name.toLowerCase().includes(term)) : counterparties;

  function openDropdown() {
    const el = inputRef.current;
    if (el) {
      const r = el.getBoundingClientRect();
      setRect({ top: r.bottom + 2, left: r.left, width: Math.max(r.width, 208) });
    }
    setOpen(true);
  }

  useEffect(() => {
    if (!open) return;
    function close() { setOpen(false); }
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
    };
  }, [open]);

  async function commit(hit?: Counterparty) {
    setOpen(false);
    const chosen = hit ?? counterparties.find(c => c.name.toLowerCase() === term);
    if (chosen) { onPick(chosen.id, chosen.name); return; }
    const trimmed = value.trim();
    if (!trimmed) { onPick("", ""); return; } // 지우고 나가면 실제로 연결 해제(저장)돼야 함
    if (busy) return;
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
    // 한글 입력 중 Enter는 조합 확정용으로 먼저 소모될 수 있음 — 조합 중엔 무시.
    if (e.key === "Enter" && !e.nativeEvent.isComposing && e.keyCode !== 229) {
      e.preventDefault(); commit(open && hits.length > 0 ? hits[active] : undefined); return;
    }
    if (e.key === "Escape") { setOpen(false); return; }
    onKeyDownNav?.(e);
  }

  return (
    <div className="relative w-full">
      <input
        ref={inputRef}
        id={id}
        value={value}
        placeholder="거래처 입력"
        onChange={e => { onTextChange(e.target.value); setActive(0); openDropdown(); }}
        onFocus={openDropdown}
        onBlur={() => setTimeout(() => { setOpen(false); commit(); }, 150)}
        onKeyDown={handleKey}
        className={styles.gridInput}
      />
      {open && rect && createPortal(
        <div
          style={{ position: "fixed", top: rect.top, left: rect.left, width: rect.width }}
          className="z-50 bg-white border border-gray-300 rounded-lg shadow-lg max-h-56 overflow-auto text-xs"
        >
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
        </div>,
        document.body
      )}
    </div>
  );
}
