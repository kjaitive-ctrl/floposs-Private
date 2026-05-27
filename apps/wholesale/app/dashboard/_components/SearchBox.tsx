"use client";

import { useState } from "react";
import Button from "./Button";
import { INPUT_MD } from "./DataTable";

export type Suggestion = {
  text: string;
  sub?: string;
};

type Props = {
  placeholder?: string;
  onSearch: (q: string) => void;
  onQueryChange?: (q: string) => void;
  suggestions?: Suggestion[];
  inputWidth?: string;
  initialValue?: string;
};

export default function SearchBox({
  placeholder = "검색...",
  onSearch,
  onQueryChange,
  suggestions = [],
  inputWidth = "w-72",
  initialValue = "",
}: Props) {
  const [input, setInput] = useState(initialValue);
  const [committed, setCommitted] = useState(initialValue);
  const [showSugg, setShowSugg] = useState(false);

  function commit(q: string) {
    setInput(q);
    setCommitted(q);
    onSearch(q);
    setShowSugg(false);
  }

  function handleChange(v: string) {
    setInput(v);
    onQueryChange?.(v);
    setShowSugg(true);
  }

  function handleClear() {
    setInput("");
    setCommitted("");
    onQueryChange?.("");
    onSearch("");
    setShowSugg(false);
  }

  return (
    <div className="relative">
      <div className="flex gap-2">
        <input
          type="text"
          value={input}
          onChange={e => handleChange(e.target.value)}
          onKeyDown={e => {
            if (e.key === "Enter") commit(input);
            if (e.key === "Escape") setShowSugg(false);
          }}
          onFocus={() => suggestions.length > 0 && setShowSugg(true)}
          onBlur={() => setTimeout(() => setShowSugg(false), 150)}
          placeholder={placeholder}
          className={`${inputWidth} ${INPUT_MD}`}
        />
        <Button onClick={() => commit(input)}>검색</Button>
        {committed && (
          <button
            onClick={handleClear}
            className="px-3 py-2 text-xs text-gray-400 hover:text-gray-600 border border-gray-300 rounded-lg"
          >
            초기화
          </button>
        )}
      </div>
      {showSugg && suggestions.length > 0 && (
        <div className="absolute top-full left-0 z-30 w-full min-w-[18rem] bg-white border border-gray-200 rounded-lg shadow-lg mt-1 overflow-hidden">
          {suggestions.map((s, i) => (
            <button
              key={i}
              onMouseDown={() => commit(s.text)}
              className="w-full flex items-center justify-between px-4 py-2 text-sm text-gray-700 hover:bg-primary-soft hover:text-primary-hover border-b border-gray-50 last:border-0"
            >
              <span>{s.text}</span>
              {s.sub && (
                <span className="ml-3 font-mono text-xs text-gray-400 shrink-0">{s.sub}</span>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
