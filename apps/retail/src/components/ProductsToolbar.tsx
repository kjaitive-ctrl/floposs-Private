"use client";

import { useState, KeyboardEvent, ReactNode } from "react";

// /samples + /products 공통 toolbar.
// 좌측: 검색(셀렉트+입력, Enter) + 카테고리 + 거래처(예정,비활성) + 페이지사이즈
// 우측: rightActions (페이지별 다른 버튼)

export type SearchCol = "wholesale_name" | "wholesale_supplier";

interface Props {
  // 검색
  searchCol: SearchCol;
  onSearchColChange: (c: SearchCol) => void;
  searchValue: string;
  onSearchSubmit: (value: string) => void;  // Enter 시. 부모는 applied state + page 1 reset.

  // 카테고리 필터 ("" = 전체)
  category: string;
  onCategoryChange: (c: string) => void;
  categoryOptions: string[];

  // 페이지 사이즈
  pageSize: number;
  onPageSizeChange: (n: number) => void;

  rightActions?: ReactNode;
}

const sel = "px-2 py-1.5 border border-gray-300 rounded text-xs text-black focus:outline-none focus:ring-1 focus:ring-black bg-white";
const inp = "px-2 py-1.5 border border-gray-300 rounded text-xs text-black focus:outline-none focus:ring-1 focus:ring-black bg-white";

export default function ProductsToolbar({
  searchCol, onSearchColChange,
  searchValue, onSearchSubmit,
  category, onCategoryChange, categoryOptions,
  pageSize, onPageSizeChange,
  rightActions,
}: Props) {
  // 입력 중인 값은 내부 draft, Enter 시점에 부모로 commit.
  // 외부 searchValue (검색 clear 등) 변경 시 동기화 — render-time derived state.
  const [draft, setDraft] = useState(searchValue);
  const [prev, setPrev] = useState(searchValue);
  if (searchValue !== prev) {
    setPrev(searchValue);
    setDraft(searchValue);
  }

  function handleKey(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter") {
      e.preventDefault();
      onSearchSubmit(draft.trim());
    }
  }

  return (
    <div className="flex items-center gap-2 flex-wrap">
      <select value={searchCol} onChange={e => onSearchColChange(e.target.value as SearchCol)} className={sel}>
        <option value="wholesale_name">상품명</option>
        <option value="wholesale_supplier">거래처</option>
      </select>
      <input
        value={draft}
        onChange={e => setDraft(e.target.value)}
        onKeyDown={handleKey}
        placeholder="검색어 입력 후 Enter"
        className={inp + " w-56"}
      />
      <select value={category} onChange={e => onCategoryChange(e.target.value)} className={sel}>
        <option value="">전체 카테고리</option>
        {categoryOptions.map(c => (
          <option key={c} value={c}>{c}</option>
        ))}
      </select>
      {/* 거래처 필터 — 공간만 확보 (Q2). 추후 활성화. */}
      <select disabled className={sel + " opacity-40 cursor-not-allowed"} title="추후 추가 예정">
        <option>거래처 (예정)</option>
      </select>
      <select value={pageSize} onChange={e => onPageSizeChange(Number(e.target.value))} className={sel}>
        <option value={25}>25개씩</option>
        <option value={50}>50개씩</option>
        <option value={100}>100개씩</option>
      </select>
      {rightActions && <div className="ml-auto flex items-center gap-2">{rightActions}</div>}
    </div>
  );
}
