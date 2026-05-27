"use client";

import { type ReactNode } from "react";

// ─── 페이지 헤더 ───────────────────────────────────────────────────────────────
// title = 우상 라벨 (페이지명). children = 좌측 (탭/컨트롤). subtitle = 라벨 아래 보조.
// 액션 버튼은 PageActionBar 로 분리.
type PageHeaderProps = {
  title: string;
  subtitle?: string;
  children?: ReactNode;
};

export function PageHeader({ children }: PageHeaderProps) {
  // 관리자 요청 (2026-05-11) — 모든 메뉴 상단 헤더 (title/subtitle) 영역 제거.
  // children 만 표시 (POS 탭 등). children 없으면 null.
  if (!children) return null;
  return (
    <div className="flex items-center mb-3 shrink-0 gap-4">
      {children}
    </div>
  );
}

// ─── 페이지 하단 고정 액션바 ────────────────────────────────────────────────────
// 화면 최하단 고정. 사이드바(w-40) 회피. 페이지 큰 액션 버튼 (등록/저장/처리/정산 등).
// 페이지 컨텐츠와 안 겹치도록 root 에 pb-20 또는 자체 spacer 필요.
export function PageActionBar({ children }: { children: ReactNode }) {
  return (
    <div className="fixed bottom-0 left-40 right-0 bg-white border-t border-gray-200 px-8 py-3 flex items-center justify-end gap-2 z-30 shadow-[0_-2px_6px_rgba(0,0,0,0.04)]">
      {children}
    </div>
  );
}

// PageActionBar 사용 시 컨텐츠 하단 spacer (가려짐 방지)
export const PAGE_ACTION_BAR_SPACER = "pb-20";

// ─── 배지 ─────────────────────────────────────────────────────────────────────
const BADGE_COLORS = {
  gray:    "bg-gray-100 text-gray-500",
  blue:    "bg-primary-soft text-primary",
  orange:  "bg-orange-50 text-orange-500",
  yellow:  "bg-yellow-50 text-yellow-600",
  green:   "bg-green-100 text-green-700",
  red:     "bg-red-50 text-red-400",
  purple:  "bg-purple-50 text-purple-600",
  emerald: "bg-emerald-50 text-emerald-600",
} as const;

type BadgeColor = keyof typeof BADGE_COLORS;

type BadgeProps = {
  color?: BadgeColor;
  children: ReactNode;
  className?: string;
};

export function Badge({ color = "gray", children, className }: BadgeProps) {
  return (
    <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${BADGE_COLORS[color]} ${className ?? ""}`}>
      {children}
    </span>
  );
}

// ─── 테이블 빈 상태 / 로딩 행 ─────────────────────────────────────────────────
type EmptyRowProps = {
  colSpan: number;
  message?: string;
};

export function EmptyRow({ colSpan, message = "데이터가 없습니다." }: EmptyRowProps) {
  return (
    <tr>
      <td colSpan={colSpan} className="text-center py-16 text-gray-300 text-sm">{message}</td>
    </tr>
  );
}

export function LoadingRow({ colSpan }: { colSpan: number }) {
  return (
    <tr>
      <td colSpan={colSpan} className="text-center py-16 text-gray-300 text-sm">불러오는 중...</td>
    </tr>
  );
}

// ─── input 공통 클래스 ───────────────────────────────────────────────────────
// 모든 input/select/textarea 는 .input-sm / .input-md 클래스 사용 (globals.css 정의).
// 아래 상수는 className={INPUT_MD} 식 사용 시 편의용. 직접 "input-md" 문자열도 OK.
export const INPUT_SM = "input-sm";
export const INPUT_MD = "input-md";

// 하위호환 alias (점진 제거 예정)
export const DATE_INPUT_CLS = INPUT_SM;
export const FILTER_INPUT_CLS = INPUT_SM;

// ─── 스크롤 컨테이너 ───────────────────────────────────────────────────────────
type DataTableProps = {
  children: ReactNode;
  footer?: ReactNode;
  maxHeight?: string;
  className?: string;
};

export function DataTable({ children, footer, maxHeight = "calc(100vh - 260px)", className }: DataTableProps) {
  return (
    <div
      className={`bg-white rounded-xl border border-gray-200 overflow-auto ${className ?? ""}`}
      style={{ maxHeight }}
    >
      <table className="w-full text-sm">{children}</table>
      {footer}
    </div>
  );
}

// ─── 틀고정 헤더 행 ────────────────────────────────────────────────────────────
export function TableHead({ children }: { children: ReactNode }) {
  return (
    <thead className="sticky top-0 z-10">
      <tr className="bg-gray-50 border-b border-gray-200">{children}</tr>
    </thead>
  );
}

// ─── 헤더 셀 (기본 중앙정렬) ──────────────────────────────────────────────────
type ThProps = {
  children?: ReactNode;
  className?: string;
};

export function Th({ children, className }: ThProps) {
  return (
    <th className={`text-center px-4 py-3 text-gray-600 font-medium whitespace-nowrap bg-gray-50 ${className ?? ""}`}>
      {children}
    </th>
  );
}

// ─── 체크박스 헤더 셀 ─────────────────────────────────────────────────────────
type SelectThProps = {
  checked: boolean;
  onChange: () => void;
};

export function SelectTh({ checked, onChange }: SelectThProps) {
  return (
    <th className="w-10 px-5 py-3 bg-gray-50">
      <input type="checkbox" checked={checked} onChange={onChange} className="rounded" />
    </th>
  );
}

// ─── 체크박스 데이터 셀 (넓은 클릭 영역) ──────────────────────────────────────
type SelectTdProps = {
  checked: boolean;
  onToggle: () => void;
};

export function SelectTd({ checked, onToggle }: SelectTdProps) {
  return (
    <td className="px-5 py-4 text-center cursor-pointer" onClick={onToggle}>
      <input type="checkbox" checked={checked} onChange={() => {}} className="rounded pointer-events-none" />
    </td>
  );
}

// ─── 페이지네이션 ─────────────────────────────────────────────────────────────
type TablePaginationProps = {
  page: number;
  totalPages: number;
  total: number;
  onPage: (p: number) => void;
};

export function TablePagination({ page, totalPages, total, onPage }: TablePaginationProps) {
  if (totalPages <= 1) return null;
  return (
    <div className="flex items-center justify-between px-5 py-3 border-t border-gray-100 bg-white sticky bottom-0">
      <p className="text-xs text-gray-500">총 {total.toLocaleString()}개 · {page + 1} / {totalPages} 페이지</p>
      <div className="flex gap-1">
        <button onClick={() => onPage(0)} disabled={page === 0}
          className="px-2 py-1 text-xs border border-gray-300 rounded hover:bg-gray-50 disabled:opacity-30">«</button>
        <button onClick={() => onPage(page - 1)} disabled={page === 0}
          className="px-3 py-1 text-xs border border-gray-300 rounded hover:bg-gray-50 disabled:opacity-30">이전</button>
        {Array.from({ length: Math.min(5, totalPages) }, (_, i) => {
          const start = Math.max(0, Math.min(page - 2, totalPages - 5));
          const pg = start + i;
          return (
            <button key={pg} onClick={() => onPage(pg)}
              className={`px-3 py-1 text-xs border rounded ${page === pg ? "bg-primary text-white border-primary" : "border-gray-300 hover:bg-gray-50"}`}>
              {pg + 1}
            </button>
          );
        })}
        <button onClick={() => onPage(page + 1)} disabled={page >= totalPages - 1}
          className="px-3 py-1 text-xs border border-gray-300 rounded hover:bg-gray-50 disabled:opacity-30">다음</button>
        <button onClick={() => onPage(totalPages - 1)} disabled={page >= totalPages - 1}
          className="px-2 py-1 text-xs border border-gray-300 rounded hover:bg-gray-50 disabled:opacity-30">»</button>
      </div>
    </div>
  );
}
