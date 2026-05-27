"use client";

import { useState, useEffect, useRef, ReactNode } from "react";

// 회색 (!) 도움말 아이콘 — 클릭 시 popover 표시, 외부 클릭 시 닫힘.
// retail-site/src/components/HelpDot.tsx 와 동일 (수동 복사 동기화. 변경 시 양쪽 갱신).

export default function HelpDot({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement | null>(null);

  useEffect(() => {
    if (!open) return;
    function handleOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    const t = setTimeout(() => document.addEventListener("mousedown", handleOutside), 0);
    return () => { clearTimeout(t); document.removeEventListener("mousedown", handleOutside); };
  }, [open]);

  return (
    <span ref={ref} className="inline-flex items-center relative">
      <button
        type="button"
        onClick={() => setOpen(s => !s)}
        title="설명 보기"
        className="inline-flex items-center justify-center w-3.5 h-3.5 rounded-full bg-gray-300 text-white text-[10px] font-bold leading-none hover:bg-gray-400"
      >
        !
      </button>
      {open && (
        <div className="absolute top-full left-1/2 -translate-x-1/2 mt-1 w-72 p-2 text-xs text-left text-gray-700 bg-white border border-gray-300 rounded shadow-lg z-30 font-normal normal-case whitespace-normal break-words leading-relaxed">
          {children}
        </div>
      )}
    </span>
  );
}
