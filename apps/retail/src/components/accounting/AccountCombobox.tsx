"use client";

// 계정과목 입력 — 드롭다운 선택이 아니라 "타이핑 후 매칭". 기존 이름과 매칭되면
// 그 계정 재사용, 없으면 Enter/blur 시 새 계정 생성(코드는 DB가 자동 부여).
// 완전 controlled — value 는 항상 부모 state.
// 드롭다운은 document.body 로 포탈 — 이 콤보박스가 쓰이는 매트릭스 표가
// overflow-x-auto 컨테이너 안에 있어서(CSS 스펙상 overflow-x:auto면 overflow-y도
// 사실상 auto로 강제돼 absolute 드롭다운이 잘림), 뷰포트 기준 고정 위치로 그려야 안 잘림.
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
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
  const [rect, setRect] = useState<{ top: number; left: number; width: number } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const term = value.trim().toLowerCase();
  const hits = term ? accounts.filter(a => a.name.toLowerCase().includes(term)) : accounts;

  function openDropdown() {
    const el = inputRef.current;
    if (el) {
      const r = el.getBoundingClientRect();
      setRect({ top: r.bottom + 2, left: r.left, width: Math.max(r.width, 208) });
    }
    setOpen(true);
  }

  // 스크롤되면 포탈 위치가 안 맞으니 일단 닫음(스크롤 캡처는 window 에 걸어야
  // 내부 overflow 컨테이너 스크롤도 잡힘 — scroll 이벤트는 버블 안 되고 캡처만 됨).
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
        placeholder="계정 입력"
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
        </div>,
        document.body
      )}
    </div>
  );
}
