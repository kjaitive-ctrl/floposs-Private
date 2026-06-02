"use client";

// 주소(건물→층→구분→열→호)로 매장을 찾아 내 거래처로 등록 (안건3 C2).
// 이름 대신 주소(slot)로 찾아 중복등록 최소화 — 같은 자리는 유일하므로 이름이 달라도 수렴.
// 결과 선택 = ensureRetailSupplier / 자리에 매장 없으면 그 주소 prefill 로 신규등록.
// [[project_retail_slot_order_portal_v2]] [[feedback_retail_browser_supabase_direct]]
import { useEffect, useState } from "react";
import { styles } from "@/common/styles";
import {
  loadSlotBuildings, loadFieldOptions, searchSlotsByAddress, ensureRetailSupplier,
  slotLabel, type BuildingDef, type FieldOpt, type SlotStoreHit,
} from "@/lib/retailSuppliers";
import SupplierRegisterModal from "@/components/SupplierRegisterModal";

interface Props {
  tenantId: string;
  onPicked: () => void;   // 거래처 추가 후 부모(내 거래처) 목록 갱신
}

export default function SupplierAddressSearch({ tenantId, onPicked }: Props) {
  const [buildings, setBuildings] = useState<BuildingDef[]>([]);
  const [floorOpts, setFloorOpts] = useState<FieldOpt[]>([]);
  const [sectionOpts, setSectionOpts] = useState<FieldOpt[]>([]);
  const [wingOpts, setWingOpts] = useState<FieldOpt[]>([]);

  const [building, setBuilding] = useState("");
  const [floor, setFloor] = useState("");
  const [section, setSection] = useState("");
  const [wing, setWing] = useState("");
  const [unit, setUnit] = useState("");

  const [results, setResults] = useState<SlotStoreHit[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [registerOpen, setRegisterOpen] = useState(false);

  useEffect(() => {
    loadSlotBuildings().then(setBuildings);
    loadFieldOptions("floor").then(setFloorOpts);
    loadFieldOptions("section").then(setSectionOpts);
    loadFieldOptions("wing").then(setWingOpts);
  }, []);

  async function search() {
    if (!building) { alert("건물을 먼저 선택하세요."); return; }
    setLoading(true);
    const hits = await searchSlotsByAddress({
      building,
      floor: floor === "" ? null : parseInt(floor, 10),
      section: section || null,
      wing: wing || null,
      unit: unit.trim() || undefined,
    });
    setResults(hits);
    setLoading(false);
  }

  async function pick(hit: SlotStoreHit) {
    const sid = await ensureRetailSupplier(tenantId, hit.slot.id, hit.id);
    if (sid) onPicked();
    else alert("거래처 등록에 실패했습니다.");
  }

  return (
    <div>
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
        <select value={building} onChange={(e) => setBuilding(e.target.value)} className={`${styles.inputMd} bg-white`}>
          <option value="">건물 선택</option>
          {buildings.map((b) => <option key={b.name} value={b.name}>{b.name}</option>)}
        </select>
        <select value={floor} onChange={(e) => setFloor(e.target.value)} className={`${styles.inputMd} bg-white`}>
          <option value="">층</option>
          {floorOpts.map((o) => <option key={o.value} value={o.value}>{o.label ?? o.value}</option>)}
        </select>
        <select value={section} onChange={(e) => setSection(e.target.value)} className={`${styles.inputMd} bg-white`}>
          <option value="">구분</option>
          {sectionOpts.map((o) => <option key={o.value} value={o.value}>{o.label ?? o.value}</option>)}
        </select>
        <select value={wing} onChange={(e) => setWing(e.target.value)} className={`${styles.inputMd} bg-white`}>
          <option value="">열</option>
          {wingOpts.map((o) => <option key={o.value} value={o.value}>{o.label ?? o.value}</option>)}
        </select>
        <input
          value={unit}
          onChange={(e) => setUnit(e.target.value)}
          placeholder="호 (예: 124)"
          className={`${styles.inputMd} bg-white`}
          onKeyDown={(e) => { if (e.key === "Enter") search(); }}
        />
        <button type="button" onClick={search} disabled={loading} className={styles.btnPrimary}>
          {loading ? "검색…" : "검색"}
        </button>
      </div>

      {results !== null && (
        <div className="mt-2">
          {results.length === 0 ? (
            <div className="text-xs text-gray-600 bg-white border border-gray-200 rounded px-3 py-2">
              이 주소에 등록된 매장이 없습니다.
              <button type="button" onClick={() => setRegisterOpen(true)} className="ml-1 text-primary font-medium hover:underline">
                이 자리에 신규 등록 →
              </button>
            </div>
          ) : (
            <ul className="space-y-1 max-h-60 overflow-auto">
              {results.map((h) => (
                <li key={h.id}>
                  <button
                    type="button"
                    onClick={() => pick(h)}
                    className="w-full text-left bg-white border border-gray-200 rounded px-3 py-1.5 hover:border-black transition-colors"
                  >
                    <div className="text-sm font-medium text-black">{h.store_name}</div>
                    <div className="text-[11px] text-gray-500">
                      {slotLabel(h.slot)}{h.smartphone ? ` · ${h.smartphone}` : ""}
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {registerOpen && (
        <SupplierRegisterModal
          tenantId={tenantId}
          initialName=""
          initialBuilding={building}
          initialFloor={floor === "" ? undefined : parseInt(floor, 10)}
          initialUnit={unit}
          onDone={() => { setRegisterOpen(false); onPicked(); }}
          onClose={() => setRegisterOpen(false)}
        />
      )}
    </div>
  );
}
