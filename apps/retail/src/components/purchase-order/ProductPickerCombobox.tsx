"use client";

// 상품명 입력 — 타이핑 후 매칭(계정과목/거래처 콤보박스와 같은 결). 등록된
// 상품과 매칭되면 그 상품 pick(도매상품명/단가/거래처/옵션 자동채움), 안
// 맞으면 그냥 자유텍스트로 남음(새 상품을 여기서 만들진 않음).
// 드롭다운은 document.body 로 포탈 — [[feedback_soft_delete_persistent_rows]]
// 와 별개로, 표가 overflow-x-auto 안에 있을 때 잘리는 문제 방지(AccountCombobox 참고).
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { styles } from "@/common/styles";
import { type OrderProduct } from "@/lib/purchaseOrder";

interface Props {
  id?: string;
  products: OrderProduct[];
  value: string;
  onTextChange: (text: string) => void;
  onPick: (product: OrderProduct) => void;
  onBlurCommit?: () => void;  // 매칭 안 되는 자유텍스트도 blur 시 저장하고 싶을 때
  onKeyDownNav?: (e: KeyboardEvent<HTMLInputElement>) => void;
}

export default function ProductPickerCombobox({ id, products, value, onTextChange, onPick, onBlurCommit, onKeyDownNav }: Props) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [rect, setRect] = useState<{ top: number; left: number; width: number } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const term = value.trim().toLowerCase();
  const hits = term
    ? products.filter(p =>
        (p.consumer_name ?? "").toLowerCase().includes(term) ||
        (p.wholesale_name ?? "").toLowerCase().includes(term))
    : products;

  function openDropdown() {
    const el = inputRef.current;
    if (el) {
      const r = el.getBoundingClientRect();
      setRect({ top: r.bottom + 2, left: r.left, width: Math.max(r.width, 224) });
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

  function commit(hit?: OrderProduct) {
    setOpen(false);
    if (hit) onPick(hit);
  }

  function handleKey(e: KeyboardEvent<HTMLInputElement>) {
    if (open && hits.length > 0) {
      if (e.key === "ArrowDown") { e.preventDefault(); setActive(a => Math.min(a + 1, hits.length - 1)); return; }
      if (e.key === "ArrowUp") { e.preventDefault(); setActive(a => Math.max(a - 1, 0)); return; }
    }
    if (e.key === "Enter" && !e.nativeEvent.isComposing && e.keyCode !== 229) {
      if (open && hits.length > 0) { e.preventDefault(); commit(hits[active]); return; }
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
        placeholder="상품명"
        onChange={e => { onTextChange(e.target.value); setActive(0); openDropdown(); }}
        onFocus={openDropdown}
        onBlur={() => setTimeout(() => { setOpen(false); onBlurCommit?.(); }, 150)}
        onKeyDown={handleKey}
        className={styles.gridInput}
      />
      {open && rect && hits.length > 0 && createPortal(
        <div
          style={{ position: "fixed", top: rect.top, left: rect.left, width: rect.width }}
          className="z-50 bg-white border border-gray-300 rounded-lg shadow-lg max-h-56 overflow-auto text-xs"
        >
          {hits.map((p, i) => (
            <button key={p.id} type="button" onMouseDown={e => { e.preventDefault(); commit(p); }}
              className={`w-full text-left px-3 py-1.5 border-b border-gray-100 ${i === active ? "bg-gray-100" : "hover:bg-gray-50"}`}>
              <span className="font-medium text-black">{p.consumer_name || p.wholesale_name}</span>
              {p.wholesale_supplier && <span className="text-gray-400 ml-1">({p.wholesale_supplier})</span>}
            </button>
          ))}
        </div>,
        document.body
      )}
    </div>
  );
}
