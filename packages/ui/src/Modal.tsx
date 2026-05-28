"use client";

import { useEffect, useRef } from "react";

// 모달 컨테이너 — apps/wholesale + apps/admin 공통 사용.
// 옛 위치: wholesale/app/dashboard/_components/Modal.tsx → packages/ui 로 이전 (Day 3).
// 호환 위해 default export + named export 둘 다 제공.
type Size = "sm" | "md" | "lg" | "xl" | "2xl" | "3xl";

// Tailwind max-w-* 클래스 대신 px 직접 지정 — 공유 컴포넌트(packages/ui)라
// 소비 앱의 Tailwind content 스캔(node_modules 제외)에서 클래스가 누락돼
// 너비 제한이 안 먹는 문제 방지. 인라인 style 로 못 박는다.
const SIZE_PX: Record<Size, number> = {
  sm:    384,
  md:    448,
  lg:    512,
  xl:    576,
  "2xl": 672,
  "3xl": 768,
};

type Props = {
  children: React.ReactNode;
  onClose?: () => void;
  size?: Size;
  /** @deprecated size prop 사용. 기존 코드 호환용. */
  maxWidth?: string;
};

export function Modal({ children, onClose, size = "lg", maxWidth }: Props) {
  const ref = useRef<HTMLDivElement>(null);

  // ESC 닫기
  useEffect(() => {
    if (!onClose) return;
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose!();
    }
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [onClose]);

  // 진입 시 첫 입력 자동 focus
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
        className="bg-white rounded-2xl shadow-xl w-full"
        // max-w / max-h / overflow 를 클래스 대신 인라인으로 — packages/ui 의 Tailwind
        // 클래스가 소비 앱 스캔에서 누락돼 너비/높이 제한이 안 먹는 문제 방지.
        style={{ maxWidth: maxWidth ?? `${SIZE_PX[size]}px`, maxHeight: "90vh", overflowY: "auto" }}
        onClick={e => e.stopPropagation()}
      >
        {children}
      </div>
    </div>
  );
}

export default Modal;
