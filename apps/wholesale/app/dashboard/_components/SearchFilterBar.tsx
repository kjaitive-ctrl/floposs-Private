"use client";

import { useState } from "react";
import SearchBox, { type Suggestion } from "./SearchBox";
import { DATE_PRESETS, getPresetRange } from "@/lib/format";
import { INPUT_MD } from "./DataTable";

type FilterGroup = {
  options: { key: string; label: string; activeColor?: string }[];
  active: string;
  onChange: (key: string) => void;
};

type DateRange = {
  from: string;
  to: string;
  onChange: (from: string, to: string) => void;
  showPresets?: boolean;
};

type Props = {
  onSearch: (q: string) => void;
  onQueryChange?: (q: string) => void;
  suggestions?: Suggestion[];
  placeholder?: string;
  filterGroups?: FilterGroup[];
  dateRange?: DateRange;
  initialValue?: string;
};


export default function SearchFilterBar({
  onSearch,
  onQueryChange,
  suggestions,
  placeholder = "검색...",
  filterGroups,
  dateRange,
  initialValue,
}: Props) {
  const [activePreset, setActivePreset] = useState("");

  function applyPreset(key: string) {
    if (!dateRange) return;
    if (activePreset === key) {
      setActivePreset("");
      dateRange.onChange("", "");
    } else {
      const [from, to] = getPresetRange(key);
      setActivePreset(key);
      dateRange.onChange(from, to);
    }
  }

  function handleManualChange(from: string, to: string) {
    setActivePreset("");
    dateRange?.onChange(from, to);
  }

  return (
    <div className="flex flex-wrap gap-3 mb-4">
      <SearchBox
        placeholder={placeholder}
        onSearch={onSearch}
        onQueryChange={onQueryChange}
        suggestions={suggestions}
        initialValue={initialValue}
      />
      {dateRange && (
        <>
          {dateRange.showPresets && (
            <div className="flex rounded-lg border border-gray-300 overflow-hidden text-sm">
              {DATE_PRESETS.map(p => (
                <button key={p.key} onClick={() => applyPreset(p.key)}
                  className={`px-3 py-2 transition-colors ${
                    activePreset === p.key ? "bg-primary text-white" : "text-gray-600 hover:bg-gray-50"
                  }`}>
                  {p.label}
                </button>
              ))}
            </div>
          )}
          <div className="flex items-center gap-2 text-sm">
            <input type="date" value={dateRange.from}
              onChange={e => handleManualChange(e.target.value, dateRange.to)}
              className={INPUT_MD} />
            <span className="text-gray-400">~</span>
            <input type="date" value={dateRange.to}
              onChange={e => handleManualChange(dateRange.from, e.target.value)}
              className={INPUT_MD} />
            {(dateRange.from || dateRange.to) && (
              <button onClick={() => { setActivePreset(""); dateRange.onChange("", ""); }}
                className="px-3 py-2 text-xs text-gray-400 hover:text-gray-600 border border-gray-300 rounded-lg">
                초기화
              </button>
            )}
          </div>
        </>
      )}
      {filterGroups?.map((group, i) => (
        <div key={i} className="flex rounded-lg border border-gray-300 overflow-hidden text-sm">
          {group.options.map(opt => (
            <button key={opt.key} onClick={() => group.onChange(opt.key)}
              className={`px-4 py-2 transition-colors ${
                group.active === opt.key
                  ? (opt.activeColor ?? "bg-primary text-white")
                  : "text-gray-600 hover:bg-gray-50"
              }`}>
              {opt.label}
            </button>
          ))}
        </div>
      ))}
    </div>
  );
}
