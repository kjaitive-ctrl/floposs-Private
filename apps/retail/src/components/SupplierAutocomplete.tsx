"use client";

// 샘플 공급사(매장) 인라인 자동완성 셀. /samples 표 안에서 사용.
// 타이핑 = slot_stores 검색 → dropdown 선택 시 retail_supplier 박제 + 매장명 텍스트.
// 검색에 없으면 dropdown 하단 "+ 신규 등록" → SupplierRegisterModal (빠른등록 + 중복가드).
// 그냥 타이핑만 하고 안 고르면 free text (retail_supplier_id = null) fallback.
// dropdown 은 표 overflow 에 안 잘리게 position:fixed.
// [[project_retail_slot_order_portal_v2]]
import { useRef, useState, type KeyboardEvent } from "react";
import { searchSlotStores, ensureRetailSupplier, slotLabel, shortSlotLabel, type SlotStoreHit } from "@/lib/retailSuppliers";
import SupplierRegisterModal from "@/components/SupplierRegisterModal";

interface Props {
  id?: string;
  tenantId: string;
  value: string;               // wholesale_supplier (표시 텍스트)
  supplierId: string | null;   // retail_supplier_id (선택된 링크) — 향후 표시용
  loc?: string;                // 축약 위치 "디오트1J" (셀 옆 회색)
  readOnly?: boolean;
  className?: string;
  // 타이핑/선택 양쪽 다 이 콜백. 타이핑 = (text, null, ""), 선택 = (매장명, id, 축약위치)
  onChange: (text: string, supplierId: string | null, loc?: string) => void;
  // dropdown 닫혀있을 때 그리드 키보드 네비로 위임
  onKeyDownNav?: (e: KeyboardEvent<HTMLInputElement>) => void;
}

export default function SupplierAutocomplete({
  id, tenantId, value, supplierId, loc, readOnly, className, onChange, onKeyDownNav,
}: Props) {
  const [open, setOpen] = useState(false);
  const [hits, setHits] = useState<SlotStoreHit[]>([]);
  const [active, setActive] = useState(0);
  const [pos, setPos] = useState<{ left: number; top: number; width: number } | null>(null);
  const [registerOpen, setRegisterOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const seq = useRef(0);

  const term = value.trim();
  // 미연결 경고 — 텍스트는 있는데 거래처(retail_supplier) 링크 안 됨 → DB 박제 안 됨 (안건1 가드)
  const warn = !readOnly && term.length > 0 && !supplierId;

  function anchor() {
    const r = inputRef.current?.getBoundingClientRect();
    if (r) setPos({ left: r.left, top: r.bottom, width: Math.max(r.width, 260) });
  }

  // 타이핑 시에만 검색 (mount/programmatic 변경엔 input onChange 안 불려서 query 안 나감)
  function handleInput(text: string) {
    onChange(text, null, ""); // 타이핑 = 링크/위치 해제, free text
    if (timer.current) clearTimeout(timer.current);
    const t = text.trim();
    if (!t) { setHits([]); setOpen(false); return; }
    anchor();
    setOpen(true); // 검색 전에도 "+ 신규 등록" 줄은 보이게
    const my = ++seq.current;
    timer.current = setTimeout(async () => {
      const res = await searchSlotStores(t);
      if (my !== seq.current) return; // stale 응답 무시
      setHits(res);
      setActive(0);
    }, 250);
  }

  async function choose(hit: SlotStoreHit) {
    setOpen(false);
    const sid = await ensureRetailSupplier(tenantId, hit.slot.id, hit.id);
    onChange(hit.store_name, sid, shortSlotLabel(hit.slot)); // sid null 이면 텍스트만 (fallback)
  }

  function openRegister() {
    setOpen(false);
    setRegisterOpen(true);
  }

  function handleKey(e: KeyboardEvent<HTMLInputElement>) {
    if (open && term) {
      if (e.key === "ArrowDown") { e.preventDefault(); setActive(a => Math.min(a + 1, hits.length - 1)); return; }
      if (e.key === "ArrowUp")   { e.preventDefault(); setActive(a => Math.max(a - 1, 0)); return; }
      if (e.key === "Enter") {
        e.preventDefault();
        if (hits.length) choose(hits[active]); else openRegister();
        return;
      }
      if (e.key === "Escape")    { e.preventDefault(); setOpen(false); return; }
    }
    onKeyDownNav?.(e);
  }

  return (
    <>
      <div className="flex items-center w-full">
        <input
          id={id}
          ref={inputRef}
          value={value}
          readOnly={readOnly}
          autoComplete="off"
          placeholder={readOnly ? "" : "매장명 검색"}
          title={value || undefined}
          onChange={e => handleInput(e.target.value)}
          onKeyDown={handleKey}
          onFocus={() => { if (term) { anchor(); setOpen(true); } }}
          onBlur={() => setTimeout(() => setOpen(false), 150)}
          className={(className ?? "") + " flex-1 min-w-0" + (warn ? " ring-1 ring-inset ring-red-400" : "")}
        />
        {loc ? (
          <span className="shrink-0 px-1 text-[10px] text-gray-400 whitespace-nowrap" title={loc}>{loc}</span>
        ) : warn ? (
          <span className="shrink-0 px-1 text-[10px] text-red-500 whitespace-nowrap" title="거래처 미연결 — 저장 안 됨">미연결</span>
        ) : null}
      </div>
      {open && pos && term && (
        <div
          style={{ position: "fixed", left: pos.left, top: pos.top, width: pos.width, zIndex: 60 }}
          className="mt-0.5 bg-white border border-gray-300 rounded-lg shadow-lg max-h-64 overflow-auto text-xs">
          {hits.map((h, i) => (
            <button
              key={h.id}
              type="button"
              onMouseDown={e => { e.preventDefault(); choose(h); }}
              className={`w-full text-left px-3 py-1.5 border-b border-gray-100 ${i === active ? "bg-gray-100" : "hover:bg-gray-50"}`}>
              <div className="font-medium text-black">{h.store_name}</div>
              <div className="text-gray-500">
                {slotLabel(h.slot)}{h.smartphone ? ` · ${h.smartphone}` : ""}
              </div>
            </button>
          ))}
          <button
            type="button"
            onMouseDown={e => { e.preventDefault(); openRegister(); }}
            className="w-full text-left px-3 py-2 text-primary font-medium hover:bg-gray-50">
            + &quot;{term}&quot; 신규 등록
          </button>
        </div>
      )}

      {registerOpen && (
        <SupplierRegisterModal
          tenantId={tenantId}
          initialName={value}
          onDone={(text, sid, l) => { setRegisterOpen(false); onChange(text, sid, l); }}
          onClose={() => setRegisterOpen(false)}
        />
      )}
    </>
  );
}
