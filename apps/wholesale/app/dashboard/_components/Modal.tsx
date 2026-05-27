"use client";

import { useEffect, useRef } from "react";

type Size = "sm" | "md" | "lg" | "xl" | "2xl" | "3xl";

const SIZE_CLS: Record<Size, string> = {
  sm:    "max-w-sm",
  md:    "max-w-md",
  lg:    "max-w-lg",
  xl:    "max-w-xl",
  "2xl": "max-w-2xl",
  "3xl": "max-w-3xl",
};

type Props = {
  children: React.ReactNode;
  onClose?: () => void;
  size?: Size;
  /** @deprecated size prop 사용. 기존 코드 호환용. */
  maxWidth?: string;
};

export default function Modal({ children, onClose, size = "lg", maxWidth }: Props) {
  const widthCls = maxWidth ?? SIZE_CLS[size];
  const ref = useRef<HTMLDivElement>(null);

  // ESC 닫기 — 룰 3번
  useEffect(() => {
    if (!onClose) return;
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose!();
    }
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [onClose]);

  // 진입 시 첫 입력 자동 focus — 룰 2번
  useEffect(() => {
    const el = ref.current?.querySelector<HTMLElement>(
      "input:not([type=hidden]):not([disabled]), textarea:not([disabled]), select:not([disabled])"
    );
    el?.focus();
  }, []);

  return (
    <div
      className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4"
      onClick={onClose}
    >
      <div
        ref={ref}
        className={`bg-white rounded-2xl shadow-xl w-full ${widthCls} max-h-[90vh] overflow-y-auto`}
        onClick={e => e.stopPropagation()}
      >
        {children}
      </div>
    </div>
  );
}
