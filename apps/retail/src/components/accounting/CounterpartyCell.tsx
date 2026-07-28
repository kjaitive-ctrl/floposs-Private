"use client";

// 거래처 입력 — 타이핑 = 자유텍스트, 매칭되면 slot 거래처 링크(선택 사항).
// /samples 의 SupplierAutocomplete 와 달리 "미연결" 경고 없음 — 직원/임대인/국세청처럼
// slot 이 없는 수취인이 정상 케이스라 경고를 띄우면 오해를 줌.
import { useRef, useState, type KeyboardEvent } from "react";
import { styles } from "@/common/styles";
import { searchSlotStores, ensureRetailSupplier, type SlotStoreHit } from "@/lib/retailSuppliers";

interface Props {
  id?: string;
  tenantId: string;
  value: string;
  onPick: (name: string, supplierId: string | null) => void;
  onKeyDownNav?: (e: KeyboardEvent<HTMLInputElement>) => void;
  placeholder?: string;
}

export default function CounterpartyCell({ id, tenantId, value, onPick, onKeyDownNav, placeholder }: Props) {
  const [open, setOpen] = useState(false);
  const [hits, setHits] = useState<SlotStoreHit[]>([]);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  function handleInput(text: string) {
    onPick(text, null);
    if (timer.current) clearTimeout(timer.current);
    const t = text.trim();
    if (!t) { setHits([]); setOpen(false); return; }
    timer.current = setTimeout(async () => {
      setHits(await searchSlotStores(t));
      setOpen(true);
    }, 250);
  }

  async function choose(hit: SlotStoreHit) {
    setOpen(false);
    const sid = await ensureRetailSupplier(tenantId, hit.slot.id, hit.id);
    onPick(hit.store_name, sid);
  }

  return (
    <div className="relative w-full">
      <input
        id={id}
        value={value}
        placeholder={placeholder ?? "거래처/수취인"}
        onChange={e => handleInput(e.target.value)}
        onFocus={() => { if (value.trim()) setOpen(true); }}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        onKeyDown={onKeyDownNav}
        className={styles.gridInput}
      />
      {open && hits.length > 0 && (
        <div className="absolute left-0 top-full z-30 mt-0.5 w-56 bg-white border border-gray-300 rounded-lg shadow-lg max-h-56 overflow-auto text-xs">
          {hits.map(h => (
            <button key={h.id} type="button" onMouseDown={e => { e.preventDefault(); choose(h); }}
              className="w-full text-left px-3 py-1.5 border-b border-gray-100 hover:bg-gray-50">
              <div className="font-medium text-black">{h.store_name}</div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
