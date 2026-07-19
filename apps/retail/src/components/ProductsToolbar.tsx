"use client";

import { useState, KeyboardEvent, ReactNode } from "react";

// /samples + /products 공통 toolbar.
// 좌측: 검색(셀렉트+입력, Enter) + 카테고리 + 거래처(예정,비활성) + 페이지사이즈
// 우측: rightActions (페이지별 다른 버튼)

export type SearchCol = "consumer_name" | "wholesale_name" | "wholesale_supplier";
export type SoldOutFilter = "all" | "active" | "sold_out";

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

  // 품절 필터 (optional — /products 만 사용. /samples 는 전달 X)
  soldOutFilter?: SoldOutFilter;
  onSoldOutFilterChange?: (f: SoldOutFilter) => void;

  // 판매채널 가격 토글 (optional — /products 만. 마이그 215)
  // "" = 기준가(원화, 편집 가능). id 선택 시 그 채널 기준으로 환산해서 읽기전용 표시.
  platformOptions?: { id: string; name: string }[];
  selectedPlatformId?: string;
  onPlatformChange?: (id: string) => void;

  rightActions?: ReactNode;
}

const sel = "px-2 py-1.5 border border-gray-300 rounded text-xs text-black focus:outline-none focus:ring-1 focus:ring-black bg-white";
const inp = "px-2 py-1.5 border border-gray-300 rounded text-xs text-black focus:outline-none focus:ring-1 focus:ring-black bg-white";

export default function ProductsToolbar({
  searchCol, onSearchColChange,
  searchValue, onSearchSubmit,
  category, onCategoryChange, categoryOptions,
  pageSize, onPageSizeChange,
  soldOutFilter, onSoldOutFilterChange,
  platformOptions, selectedPlatformId, onPlatformChange,
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
        <option value="consumer_name">상품명</option>
        <option value="wholesale_name">도매상품명</option>
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
      {/* 품절 필터 — /products 만. 세그먼트 컨트롤 (서버 필터링, 마이그 202 인덱스 가속) */}
      {soldOutFilter !== undefined && onSoldOutFilterChange && (
        <div className="inline-flex rounded border border-gray-300 overflow-hidden text-xs">
          {([
            { v: "all",      label: "전체" },
            { v: "active",   label: "진행중" },
            { v: "sold_out", label: "품절" },
          ] as { v: SoldOutFilter; label: string }[]).map(opt => {
            const active = soldOutFilter === opt.v;
            return (
              <button key={opt.v}
                onClick={() => onSoldOutFilterChange(opt.v)}
                className={"px-2.5 py-1.5 border-r border-gray-300 last:border-r-0 transition-colors " + (
                  active ? "bg-black text-white" : "bg-white text-gray-700 hover:bg-gray-50"
                )}>
                {opt.label}
              </button>
            );
          })}
        </div>
      )}
      {/* 판매채널 가격 토글 — 세그먼트 컨트롤 (품절 필터와 동일 패턴). "기준"은 부모가 항상 넣어줌. */}
      {platformOptions && platformOptions.length > 0 && onPlatformChange && (
        <div className="inline-flex rounded border border-gray-300 overflow-hidden text-xs">
          {[{ id: "", name: "기준" }, ...platformOptions].map(opt => {
            const active = (selectedPlatformId ?? "") === opt.id;
            return (
              <button key={opt.id || "base"}
                onClick={() => onPlatformChange(opt.id)}
                className={"px-2.5 py-1.5 border-r border-gray-300 last:border-r-0 transition-colors whitespace-nowrap " + (
                  active ? "bg-black text-white" : "bg-white text-gray-700 hover:bg-gray-50"
                )}>
                {opt.name}
              </button>
            );
          })}
        </div>
      )}
      {rightActions && <div className="ml-auto flex items-center gap-2">{rightActions}</div>}
    </div>
  );
}
