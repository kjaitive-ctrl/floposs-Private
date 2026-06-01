"use client";

// 샘플 공급사(매장) 인라인 자동완성 셀. /samples 표 안에서 사용.
// 타이핑 = slot_stores 검색 → dropdown 선택 시 retail_supplier 박제 + 매장명 텍스트.
// 그냥 타이핑만 하고 안 고르면 free text (retail_supplier_id = null) 로 fallback.
// dropdown 은 표 overflow 에 안 잘리게 position:fixed 로 띄움.
// [[project_retail_slot_order_portal_v2]]
import { useRef, useState, type KeyboardEvent } from "react";
import { searchSlotStores, ensureRetailSupplier, slotLabel, type SlotStoreHit } from "@/lib/retailSuppliers";

interface Props {
  id?: string;
  tenantId: string;
  value: string;               // wholesale_supplier (표시 텍스트)
  supplierId: string | null;   // retail_supplier_id (선택된 링크) — 현재 미사용, 향후 표시용
  readOnly?: boolean;
  className?: string;
  // 타이핑/선택 양쪽 다 이 콜백. 타이핑 = (text, null), 선택 = (매장명, retail_supplier_id)
  onChange: (text: string, supplierId: string | null) => void;
  // dropdown 닫혀있을 때 그리드 키보드 네비로 위임
  onKeyDownNav?: (e: KeyboardEvent<HTMLInputElement>) => void;
}

export default function SupplierAutocomplete({
  id, tenantId, value, readOnly, className, onChange, onKeyDownNav,
}: Props) {
  const [open, setOpen] = useState(false);
  const [hits, setHits] = useState<SlotStoreHit[]>([]);
  const [active, setActive] = useState(0);
  const [pos, setPos] = useState<{ left: number; top: number; width: number } | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const seq = useRef(0);

  function anchor() {
    const r = inputRef.current?.getBoundingClientRect();
    if (r) setPos({ left: r.left, top: r.bottom, width: Math.max(r.width, 240) });
  }

  // 타이핑 시에만 검색 (mount/programmatic 변경엔 input onChange 안 불려서 query 안 나감)
  function handleInput(text: string) {
    onChange(text, null); // 타이핑 = 링크 해제, free text
    if (timer.current) clearTimeout(timer.current);
    const term = text.trim();
    if (!term) { setHits([]); setOpen(false); return; }
    const my = ++seq.current;
    timer.current = setTimeout(async () => {
      const res = await searchSlotStores(term);
      if (my !== seq.current) return; // stale 응답 무시
      setHits(res);
      setActive(0);
      if (res.length && document.activeElement === inputRef.current) { anchor(); setOpen(true); }
      else setOpen(false);
    }, 250);
  }

  async function choose(hit: SlotStoreHit) {
    setOpen(false);
    const sid = await ensureRetailSupplier(tenantId, hit.slot.id, hit.id);
    onChange(hit.store_name, sid); // sid null 이면 텍스트만 (fallback)
  }

  function handleKey(e: KeyboardEvent<HTMLInputElement>) {
    if (open && hits.length) {
      if (e.key === "ArrowDown") { e.preventDefault(); setActive(a => Math.min(a + 1, hits.length - 1)); return; }
      if (e.key === "ArrowUp")   { e.preventDefault(); setActive(a => Math.max(a - 1, 0)); return; }
      if (e.key === "Enter")     { e.preventDefault(); choose(hits[active]); return; }
      if (e.key === "Escape")    { e.preventDefault(); setOpen(false); return; }
    }
    onKeyDownNav?.(e);
  }

  return (
    <>
      <input
        id={id}
        ref={inputRef}
        value={value}
        readOnly={readOnly}
        autoComplete="off"
        placeholder={readOnly ? "" : "매장명 검색"}
        onChange={e => handleInput(e.target.value)}
        onKeyDown={handleKey}
        onFocus={() => { if (hits.length) { anchor(); setOpen(true); } }}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        className={className}
      />
      {open && pos && hits.length > 0 && (
        <div
          style={{ position: "fixed", left: pos.left, top: pos.top, width: pos.width, zIndex: 60 }}
          className="mt-0.5 bg-white border border-gray-300 rounded-lg shadow-lg max-h-64 overflow-auto text-xs">
          {hits.map((h, i) => (
            <button
              key={h.id}
              type="button"
              onMouseDown={e => { e.preventDefault(); choose(h); }}
              className={`w-full text-left px-3 py-1.5 border-b border-gray-100 last:border-0 ${i === active ? "bg-gray-100" : "hover:bg-gray-50"}`}>
              <div className="font-medium text-black">{h.store_name}</div>
              <div className="text-gray-500">
                {slotLabel(h.slot)}{h.smartphone ? ` · ${h.smartphone}` : ""}
              </div>
            </button>
          ))}
        </div>
      )}
    </>
  );
}
