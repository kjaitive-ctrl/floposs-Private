"use client";

// 공급사 빠른등록 모달 (B2). 자동완성에 매장이 없을 때 셀에서 바로 호출.
// 빠른등록 = 건물 + 층 + 호 + 매장명 (wing/열 생략, admin 보강). + 전화/스마트폰 선택.
// 중복가드: 매장명으로 기존 slot_stores 검색 → "혹시 이 매장?" 제안 → 재사용 유도.
// [[project_retail_slot_order_portal_v2]]
import { useEffect, useState } from "react";
import { styles } from "@/common/styles";
import {
  searchSlotStores, ensureRetailSupplier, createSlotStoreSupplier, slotLabel, shortSlotLabel,
  loadSlotBuildings, loadFloorOptions,
  type SlotStoreHit, type BuildingDef, type FieldOpt,
} from "@/lib/retailSuppliers";

const CUSTOM_BUILDING = "__custom__";

interface Props {
  tenantId: string;
  initialName: string;
  initialBuilding?: string;   // 주소검색 → "이 자리 신규등록" prefill (안건3 C2)
  initialFloor?: number;
  initialUnit?: string;
  onDone: (text: string, supplierId: string | null, loc: string) => void;
  onClose: () => void;
}

export default function SupplierRegisterModal({
  tenantId, initialName, initialBuilding, initialFloor, initialUnit, onDone, onClose,
}: Props) {
  const [buildings, setBuildings] = useState<BuildingDef[]>([]);
  const [floorOpts, setFloorOpts] = useState<FieldOpt[]>([]);

  const [buildingSelect, setBuildingSelect] = useState(initialBuilding ?? "");
  const [buildingCustom, setBuildingCustom] = useState("");
  const [customCategory, setCustomCategory] = useState("");
  const [floor, setFloor] = useState<number>(initialFloor ?? 1);
  const [unit, setUnit] = useState(initialUnit ?? "");
  const [storeName, setStoreName] = useState(initialName);
  const [phone, setPhone] = useState("");
  const [smart, setSmart] = useState("");
  const [saving, setSaving] = useState(false);

  // 중복가드 — 매장명 유사 매장
  const [dupHits, setDupHits] = useState<SlotStoreHit[]>([]);

  const categories = Array.from(new Set(buildings.map(b => b.category)));
  const isCustom = buildingSelect === CUSTOM_BUILDING;
  const building = isCustom ? buildingCustom.trim() : buildingSelect;

  useEffect(() => {
    loadSlotBuildings().then(setBuildings);
    loadFloorOptions().then(opts => {
      setFloorOpts(opts);
      // 기본 층 = "1" 있으면 1, 없으면 첫 옵션 (단 prefill 된 initialFloor 는 보존)
      if (initialFloor == null && opts.length && !opts.some(o => o.value === "1")) setFloor(parseInt(opts[0].value, 10));
    });
  }, []);

  // 매장명 바뀔 때마다 중복가드 검색 (debounce)
  useEffect(() => {
    const term = storeName.trim();
    if (!term) { setDupHits([]); return; }
    const t = setTimeout(async () => setDupHits(await searchSlotStores(term, 6)), 250);
    return () => clearTimeout(t);
  }, [storeName]);

  // 기존 매장 재사용 (중복가드 제안 클릭)
  async function pickExisting(hit: SlotStoreHit) {
    setSaving(true);
    const sid = await ensureRetailSupplier(tenantId, hit.slot.id, hit.id);
    onDone(hit.store_name, sid, shortSlotLabel(hit.slot));
  }

  async function submit() {
    if (!building || !unit.trim() || !storeName.trim()) {
      alert("건물 · 호 · 매장명은 필수입니다.");
      return;
    }
    let category = buildings.find(b => b.name === building)?.category ?? null;
    if (isCustom) {
      if (!customCategory) { alert("새 건물은 카테고리를 선택하세요."); return; }
      category = customCategory;
    }
    setSaving(true);
    const res = await createSlotStoreSupplier(tenantId, {
      building, category, isCustomBuilding: isCustom,
      floor, unit, storeName, phone, smartphone: smart,
    });
    setSaving(false);
    if (!res) { alert("등록에 실패했습니다. 콘솔을 확인해주세요."); return; }
    onDone(res.storeName, res.supplierId, res.loc);
  }

  return (
    <div className={styles.modalOverlay} onMouseDown={onClose}>
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-md flex flex-col max-h-[90vh]"
        onMouseDown={e => e.stopPropagation()}>
        <div className="px-5 pt-5 pb-3 border-b border-gray-100">
          <h3 className="text-base font-bold text-black">공급사 매장 신규 등록</h3>
          <p className="text-xs text-gray-500 mt-0.5">검색에 없는 새 매장을 등록합니다. 위치(층/열)는 나중에 보강할 수 있어요.</p>
        </div>

        <div className="overflow-y-auto flex-1 px-5 py-4 space-y-3">
          {/* 중복가드 */}
          {dupHits.length > 0 && (
            <div className="rounded-lg border border-amber-200 bg-amber-50 p-2.5">
              <div className="text-xs font-semibold text-amber-800 mb-1.5">혹시 이 매장 아니에요? (이미 등록된 매장)</div>
              <div className="space-y-1">
                {dupHits.map(h => (
                  <button key={h.id} type="button" disabled={saving}
                    onClick={() => pickExisting(h)}
                    className="w-full text-left px-2 py-1.5 bg-white border border-amber-200 rounded hover:bg-amber-100 disabled:opacity-50">
                    <div className="text-xs font-medium text-black">{h.store_name}</div>
                    <div className="text-[11px] text-gray-500">{slotLabel(h.slot)}{h.smartphone ? ` · ${h.smartphone}` : ""}</div>
                  </button>
                ))}
              </div>
              <div className="text-[11px] text-amber-700 mt-1.5">위에 없으면 아래에서 신규로 등록하세요.</div>
            </div>
          )}

          <div>
            <label className={styles.modalLabel}>매장명 *</label>
            <input value={storeName} onChange={e => setStoreName(e.target.value)} autoFocus
              className={styles.inputMd} placeholder="매장명" />
          </div>

          <div>
            <label className={styles.modalLabel}>건물 *</label>
            <select value={buildingSelect} onChange={e => setBuildingSelect(e.target.value)} className={styles.inputMd}>
              <option value="">선택...</option>
              {buildings.map(b => <option key={b.name} value={b.name}>{b.name}</option>)}
              <option value={CUSTOM_BUILDING}>+ 직접 입력</option>
            </select>
            {isCustom && (
              <div className="grid grid-cols-2 gap-2 mt-2">
                <input value={buildingCustom} onChange={e => setBuildingCustom(e.target.value)}
                  placeholder="새 건물명" className={styles.inputMd} />
                <select value={customCategory} onChange={e => setCustomCategory(e.target.value)} className={styles.inputMd}>
                  <option value="">카테고리...</option>
                  {categories.map(c => <option key={c} value={c}>{c}</option>)}
                </select>
              </div>
            )}
          </div>

          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className={styles.modalLabel}>층 *</label>
              <select value={String(floor)} onChange={e => setFloor(parseInt(e.target.value, 10))} className={styles.inputMd}>
                {floorOpts.map(o => <option key={o.value} value={o.value}>{o.label ?? o.value}</option>)}
              </select>
            </div>
            <div>
              <label className={styles.modalLabel}>호 *</label>
              <input value={unit} onChange={e => setUnit(e.target.value)} placeholder="예: 124, 5-1"
                className={styles.inputMd} />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className={styles.modalLabel}>전화 (선택)</label>
              <input value={phone} onChange={e => setPhone(e.target.value)} placeholder="02-..."
                className={styles.inputMd} />
            </div>
            <div>
              <label className={styles.modalLabel}>스마트폰 (선택)</label>
              <input value={smart} onChange={e => setSmart(e.target.value)} placeholder="010-..."
                className={styles.inputMd} />
            </div>
          </div>
        </div>

        <div className="px-5 pb-5 pt-3 border-t border-gray-100 flex gap-2 justify-end">
          <button onClick={onClose} disabled={saving} className={styles.btnSecondary}>취소</button>
          <button onClick={submit} disabled={saving} className={styles.btnPrimary}>
            {saving ? "등록 중..." : "등록"}
          </button>
        </div>
      </div>
    </div>
  );
}
