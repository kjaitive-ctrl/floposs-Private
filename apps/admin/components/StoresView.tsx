"use client";

import { useEffect, useMemo, useState, useCallback } from "react";
import { supabase } from "@/lib/supabase";
import { Modal } from "@floposs/ui";

// === enum: slot_field_options / slot_buildings 테이블에서 동적 로드 (2026-06-01 db화) ===
const SECTION_KOR: Record<string, string> = { A:"가", B:"나", C:"다", D:"라", E:"마", F:"바", G:"사" };
const PAGE_SIZE = 50;

type FieldOpt = { value: string; label: string };
type BuildingDef = { name: string; category: string };

function floorLabel(f: number) { return f < 0 ? `B${-f}층` : `${f}층`; }
function sectionLabel(s: string | null) {
  if (!s) return "";
  return SECTION_KOR[s] ? `${s} (${SECTION_KOR[s]})` : s;
}

// === 타입 ===
type Slot = {
  id: string;
  building: string;
  floor: number;
  wing: string | null;
  section: string | null;
  unit: string;
  normalized_key: string;
  is_physical: boolean;
  created_at: string;
};
type SlotStore = {
  id: string;
  slot_id: string;
  store_name: string;
  phone: string | null;
  smartphone: string | null;
  store_order: number;
  is_current: boolean;
  is_hidden: boolean;
  added_at: string;
};
type SlotWithMeta = Slot & { store_count: number; current_store: string | null; current_phone: string | null };

// === 메인 뷰 ===
export function StoresView() {
  // 검색 필터 상태
  const [buildingDefs, setBuildingDefs] = useState<BuildingDef[]>([]);  // 신규/편집: 정의 + 카테고리
  const [buildings, setBuildings] = useState<string[]>([]);             // 검색 필터: slots 실제 distinct
  const [floorOpts, setFloorOpts] = useState<FieldOpt[]>([]);
  const [wingOpts, setWingOpts] = useState<FieldOpt[]>([]);
  const [sectionOpts, setSectionOpts] = useState<FieldOpt[]>([]);
  const [fBuilding, setFBuilding] = useState<Set<string>>(new Set());
  const [fWing, setFWing] = useState<Set<string>>(new Set());
  const [fFloor, setFFloor] = useState<Set<number>>(new Set());
  const [fSection, setFSection] = useState<Set<string>>(new Set());
  const [fUnitFrom, setFUnitFrom] = useState<string>("");
  const [fUnitTo, setFUnitTo] = useState<string>("");

  const [rows, setRows] = useState<SlotWithMeta[]>([]);
  const [totalCount, setTotalCount] = useState(0);
  const [page, setPage] = useState(0);
  const [loading, setLoading] = useState(false);
  const [openSlot, setOpenSlot] = useState<Slot | null>(null);
  const [addSlotOpen, setAddSlotOpen] = useState(false);

  // 정의 테이블 로드 (slot_buildings / slot_field_options) — db구조 단일 소스
  const loadDefs = useCallback(() => {
    supabase.from("slot_buildings").select("name,category").order("sort").then(({ data }) => {
      const defs = (data as BuildingDef[]) || [];
      setBuildingDefs(defs);  // 신규/편집용 정의
      // 검색 필터 buildings = 정의(slot_buildings, 4상가+정의 모두) ∪ slots 에만 있는 직접등록 건물(test 등)
      const names = defs.map(d => d.name);
      const notIn = `(${(names.length ? names : [""]).map(n => `"${n.replace(/"/g, "")}"`).join(",")})`;
      supabase.from("slots").select("building").not("building", "in", notIn).then(({ data: sd }) => {
        const extra = [...new Set((sd || []).map((r: { building: string }) => r.building))];
        setBuildings([...names, ...extra].sort((a, b) => a.localeCompare(b, "ko")));
      });
    });
    supabase.from("slot_field_options").select("field,value,label").order("sort").then(({ data }) => {
      const d = (data || []) as { field: string; value: string; label: string }[];
      const pick = (f: string) => d.filter(o => o.field === f).map(o => ({ value: o.value, label: o.label }));
      setFloorOpts(pick("floor")); setWingOpts(pick("wing")); setSectionOpts(pick("section"));
    });
  }, []);
  useEffect(() => { loadDefs(); }, [loadDefs]);

  // 데이터 fetch (필터 + 페이지)
  const fetchRows = useCallback(async () => {
    setLoading(true);
    let q = supabase.from("slots").select("*", { count: "exact" });
    if (fBuilding.size) q = q.in("building", Array.from(fBuilding));
    if (fWing.size) {
      // wing 은 NULL=없음 도 처리 — 없음 선택 시 OR null
      const list = Array.from(fWing);
      if (list.includes("(없음)")) {
        const others = list.filter(w => w !== "(없음)");
        if (others.length) q = q.or(`wing.in.(${others.map(w => `"${w}"`).join(",")}),wing.is.null`);
        else q = q.is("wing", null);
      } else {
        q = q.in("wing", list);
      }
    }
    if (fFloor.size) q = q.in("floor", Array.from(fFloor));
    if (fSection.size) {
      const list = Array.from(fSection);
      if (list.includes("(없음)")) {
        const others = list.filter(s => s !== "(없음)");
        if (others.length) q = q.or(`section.in.(${others.map(s => `"${s}"`).join(",")}),section.is.null`);
        else q = q.is("section", null);
      } else {
        q = q.in("section", list);
      }
    }
    // unit range — 숫자 변환 가능한 경우만 gte/lte
    const uf = parseInt(fUnitFrom, 10);
    const ut = parseInt(fUnitTo, 10);
    if (!isNaN(uf) || !isNaN(ut)) {
      // unit 은 TEXT — Postgres 캐스팅: regex 로 숫자만 추출 후 비교
      // 간단화: 클라이언트 측 필터 X, 서버 측 like 로는 안 됨 → RPC 없으면 가능한 범위만
      // 일단 unit 텍스트 정확 일치 (from~to 가 같으면 그것만, 아니면 range 는 LIKE 패턴 X)
      // 단순 안전: from~to 가 모두 숫자면 1~N 의 텍스트 후보 모두 IN
      if (!isNaN(uf) && !isNaN(ut) && uf <= ut && (ut - uf) <= 200) {
        const units: string[] = [];
        for (let n = uf; n <= ut; n++) units.push(String(n));
        q = q.in("unit", units);
      } else if (!isNaN(uf) && isNaN(ut)) {
        q = q.eq("unit", String(uf));
      } else if (isNaN(uf) && !isNaN(ut)) {
        q = q.eq("unit", String(ut));
      }
    }

    q = q.order("building").order("floor").order("wing", { nullsFirst: true })
         .order("section", { nullsFirst: true }).order("unit")
         .range(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE - 1);

    const { data, count, error } = await q;
    if (error) { console.error(error); setLoading(false); return; }
    const slots = (data || []) as Slot[];
    // 매장 수 + current 매장 fetch (별도 쿼리)
    if (slots.length === 0) {
      setRows([]); setTotalCount(count || 0); setLoading(false); return;
    }
    const slotIds = slots.map(s => s.id);
    const { data: stores } = await supabase
      .from("slot_stores")
      .select("slot_id, store_name, phone, smartphone, store_order, is_current")
      .in("slot_id", slotIds)
      .eq("is_hidden", false);
    type StoreLite = Pick<SlotStore, "slot_id" | "store_name" | "phone" | "smartphone" | "store_order" | "is_current">;
    const bySlot: Record<string, StoreLite[]> = {};
    (stores as StoreLite[] | null || []).forEach((st) => {
      (bySlot[st.slot_id] ||= []).push(st);
    });
    const enriched: SlotWithMeta[] = slots.map(s => {
      const list = (bySlot[s.id] || []).sort((a, b) => b.store_order - a.store_order);
      const cur = list.find(x => x.is_current) || list[0];
      return {
        ...s,
        store_count: list.length,
        current_store: cur?.store_name || null,
        current_phone: cur ? (cur.phone || cur.smartphone || null) : null,
      };
    });
    setRows(enriched);
    setTotalCount(count || 0);
    setLoading(false);
  }, [fBuilding, fWing, fFloor, fSection, fUnitFrom, fUnitTo, page]);

  useEffect(() => { fetchRows(); }, [fetchRows]);

  function resetFilters() {
    setFBuilding(new Set()); setFWing(new Set()); setFFloor(new Set());
    setFSection(new Set()); setFUnitFrom(""); setFUnitTo(""); setPage(0);
  }

  const totalPages = Math.max(1, Math.ceil(totalCount / PAGE_SIZE));

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-xl font-bold text-gray-800">매장관리</h2>
        <button onClick={() => setAddSlotOpen(true)}
          className="px-3 py-1.5 bg-primary text-white text-sm rounded-lg hover:opacity-90">
          + 슬롯 추가
        </button>
      </div>

      {/* 검색 필터 */}
      <div className="bg-white border border-gray-200 rounded-lg p-4 mb-4">
        <div className="grid grid-cols-5 gap-3">
          <MultiSelect label="건물명" options={buildings.map(b => ({ value: b, label: b }))}
            selected={fBuilding} onChange={s => { setFBuilding(s); setPage(0); }} />
          <MultiSelect label="구분" options={[
            { value: "(없음)", label: "(없음)" },
            ...wingOpts,
          ]}
            selected={fWing} onChange={s => { setFWing(s); setPage(0); }} />
          <MultiSelect label="층" options={floorOpts}
            selected={new Set(Array.from(fFloor).map(String))}
            onChange={s => { setFFloor(new Set(Array.from(s).map(Number))); setPage(0); }} />
          <MultiSelect label="열" options={[
            { value: "(없음)", label: "(없음)" },
            ...sectionOpts,
          ]}
            selected={fSection} onChange={s => { setFSection(s); setPage(0); }} />
          <div>
            <div className="text-xs font-semibold text-gray-600 mb-1">호수 (범위)</div>
            <div className="flex gap-1 items-center">
              <input type="number" placeholder="from" value={fUnitFrom}
                onChange={e => { setFUnitFrom(e.target.value); setPage(0); }}
                className="w-full border border-gray-300 rounded px-2 py-1.5 text-sm" />
              <span className="text-gray-400">~</span>
              <input type="number" placeholder="to" value={fUnitTo}
                onChange={e => { setFUnitTo(e.target.value); setPage(0); }}
                className="w-full border border-gray-300 rounded px-2 py-1.5 text-sm" />
            </div>
          </div>
        </div>
        <div className="flex items-center justify-between mt-3">
          <button onClick={resetFilters}
            className="text-xs text-gray-500 hover:text-gray-700 underline">필터 초기화</button>
          <div className="text-xs text-gray-500">
            총 <span className="font-bold text-gray-700">{totalCount.toLocaleString()}</span> 슬롯
            {loading && <span className="ml-2 text-gray-400">로딩중...</span>}
          </div>
        </div>
      </div>

      {/* 테이블 */}
      <div className="bg-white border border-gray-200 rounded-lg overflow-hidden">
        <table className="w-full text-sm table-fixed">
          <colgroup>
            <col style={{ width: "50px" }} />   {/* # */}
            <col />                              {/* 건물 (가변) */}
            <col style={{ width: "70px" }} />   {/* 층 */}
            <col style={{ width: "90px" }} />   {/* 구분 */}
            <col style={{ width: "80px" }} />   {/* 열 */}
            <col style={{ width: "70px" }} />   {/* 호 */}
            <col style={{ width: "70px" }} />   {/* 매장수 */}
            <col />                              {/* 최신매장 (가변) */}
            <col style={{ width: "130px" }} />  {/* 전화 (010-XXXX-XXXX 딱맞게) */}
            <col style={{ width: "90px" }} />   {/* 상세/이력 */}
          </colgroup>
          <thead className="bg-gray-50 border-b border-gray-200">
            <tr>
              <Th>#</Th><Th>건물</Th><Th>층</Th><Th>구분</Th><Th>열</Th><Th>호</Th>
              <Th>매장수</Th><Th>최신매장</Th><Th>전화</Th><Th></Th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && !loading && (
              <tr><td colSpan={10} className="text-center py-8 text-gray-400">데이터 없음</td></tr>
            )}
            {rows.map((r, i) => (
              <tr key={r.id} className="border-b border-gray-100 hover:bg-gray-50">
                <Td className="text-gray-400">{page * PAGE_SIZE + i + 1}</Td>
                <Td className="font-medium">{r.building}</Td>
                <Td>{floorLabel(r.floor)}</Td>
                <Td>{r.wing || ""}</Td>
                <Td>{sectionLabel(r.section)}</Td>
                <Td>{r.unit}</Td>
                <Td className={r.store_count === 0 ? "text-gray-300" : ""}>{r.store_count}</Td>
                <Td className="text-gray-700">{r.current_store || <span className="text-gray-300">(빈)</span>}</Td>
                <Td className="text-gray-500 text-xs">{r.current_phone || ""}</Td>
                <Td>
                  <button onClick={() => setOpenSlot(r)}
                    className="text-primary text-xs hover:underline">상세/이력</button>
                </Td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* 페이지네이션 */}
      <div className="flex items-center justify-center gap-2 mt-4">
        <button disabled={page === 0} onClick={() => setPage(p => Math.max(0, p - 1))}
          className="px-3 py-1 border border-gray-300 rounded text-sm disabled:opacity-30">◀</button>
        <span className="text-sm text-gray-600">
          {page + 1} / {totalPages.toLocaleString()} 페이지
        </span>
        <button disabled={page >= totalPages - 1} onClick={() => setPage(p => p + 1)}
          className="px-3 py-1 border border-gray-300 rounded text-sm disabled:opacity-30">▶</button>
        <span className="text-xs text-gray-400 ml-2">{PAGE_SIZE}개/페이지</span>
      </div>

      {openSlot && (
        <SlotDetailModal slot={openSlot} buildingDefs={buildingDefs} floorOpts={floorOpts} wingOpts={wingOpts} sectionOpts={sectionOpts} onClose={() => setOpenSlot(null)} onUpdate={fetchRows} />
      )}
      {addSlotOpen && (
        <SlotAddModal buildingDefs={buildingDefs} floorOpts={floorOpts} wingOpts={wingOpts} sectionOpts={sectionOpts} onClose={() => setAddSlotOpen(false)} onUpdate={() => { fetchRows(); loadDefs(); }} />
      )}
    </div>
  );
}

// === 헬퍼: th/td ===
function Th({ children }: { children?: React.ReactNode }) {
  return <th className="px-3 py-2 text-left text-xs font-semibold text-gray-600">{children}</th>;
}
function Td({ children, className = "" }: { children?: React.ReactNode; className?: string }) {
  return <td className={`px-3 py-2 ${className}`}>{children}</td>;
}

// === MultiSelect (체크박스 dropdown) ===
function MultiSelect({ label, options, selected, onChange }:
  { label: string; options: { value: string; label: string }[]; selected: Set<string>; onChange: (s: Set<string>) => void }) {
  const [open, setOpen] = useState(false);
  const summary = selected.size === 0 ? "전체"
    : selected.size <= 2 ? Array.from(selected).slice(0, 2).join(", ")
    : `${selected.size}개 선택`;
  function toggle(v: string) {
    const next = new Set(selected);
    if (next.has(v)) next.delete(v); else next.add(v);
    onChange(next);
  }
  return (
    <div className="relative">
      <div className="text-xs font-semibold text-gray-600 mb-1">{label}</div>
      <button onClick={() => setOpen(o => !o)}
        className="w-full border border-gray-300 rounded px-2 py-1.5 text-sm text-left bg-white hover:bg-gray-50">
        <span className={selected.size === 0 ? "text-gray-400" : "text-gray-800"}>{summary}</span>
        <span className="float-right text-gray-400">▾</span>
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="absolute z-20 mt-1 w-full bg-white border border-gray-300 rounded shadow-lg max-h-64 overflow-y-auto">
            {options.map(o => (
              <label key={o.value} className="flex items-center gap-2 px-2 py-1.5 hover:bg-gray-50 cursor-pointer">
                <input type="checkbox" checked={selected.has(o.value)} onChange={() => toggle(o.value)} />
                <span className="text-sm">{o.label}</span>
              </label>
            ))}
            {selected.size > 0 && (
              <button onClick={() => onChange(new Set())}
                className="w-full text-xs text-gray-500 hover:bg-gray-100 py-1 border-t border-gray-200">초기화</button>
            )}
          </div>
        </>
      )}
    </div>
  );
}

// === 슬롯 상세 모달 (매장이력 + admin CRUD) ===
function SlotDetailModal({ slot, buildingDefs, floorOpts, wingOpts, sectionOpts, onClose, onUpdate }: { slot: Slot; buildingDefs: BuildingDef[]; floorOpts: FieldOpt[]; wingOpts: FieldOpt[]; sectionOpts: FieldOpt[]; onClose: () => void; onUpdate: () => void }) {
  const [stores, setStores] = useState<SlotStore[]>([]);
  const [loading, setLoading] = useState(true);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [editSlot, setEditSlot] = useState(false);

  // 슬롯 자체 편집
  const [eb, setEb] = useState(slot.building);
  const [ef, setEf] = useState(slot.floor);
  const [ew, setEw] = useState(slot.wing || "");
  const [es, setEs] = useState(slot.section || "");
  const [eu, setEu] = useState(slot.unit);

  const fetchStores = useCallback(async () => {
    setLoading(true);
    const { data } = await supabase.from("slot_stores").select("*").eq("slot_id", slot.id).order("store_order");
    setStores((data || []) as SlotStore[]);
    setLoading(false);
  }, [slot.id]);
  useEffect(() => { fetchStores(); }, [fetchStores]);

  async function deleteStore(id: string) {
    if (!confirm("이 매장 이력을 삭제할까요? (admin 전용)")) return;
    await supabase.from("slot_stores").delete().eq("id", id);
    fetchStores(); onUpdate();
  }
  async function setCurrent(id: string) {
    // 모든 is_current 끄고 이거만 true
    await supabase.from("slot_stores").update({ is_current: false }).eq("slot_id", slot.id);
    await supabase.from("slot_stores").update({ is_current: true }).eq("id", id);
    fetchStores(); onUpdate();
  }
  async function toggleHidden(s: SlotStore) {
    await supabase.from("slot_stores").update({ is_hidden: !s.is_hidden }).eq("id", s.id);
    fetchStores(); onUpdate();
  }
  async function deleteSlot() {
    if (!confirm("이 슬롯을 완전히 삭제할까요? 매장이력도 모두 삭제됩니다. (admin 전용)")) return;
    await supabase.from("slots").delete().eq("id", slot.id);
    onClose(); onUpdate();
  }
  async function saveSlot() {
    if (!eb.trim() || !eu.trim()) { alert("건물명과 호수 필수"); return; }
    const nk = `${eb.trim()}:${ef}:${ew || "-"}:${es || "-"}:${eu.trim()}`;
    // 변경 없으면 그냥 닫기
    if (nk === slot.normalized_key) { setEditSlot(false); return; }
    // 다른 슬롯과 normalized_key 충돌 검증
    const { data: dup } = await supabase.from("slots").select("id").eq("normalized_key", nk).neq("id", slot.id).maybeSingle();
    if (dup) { alert(`이미 같은 슬롯이 존재합니다.\n${nk}`); return; }
    const category = buildingDefs.find(b => b.name === eb.trim())?.category ?? null;
    const { error } = await supabase.from("slots").update({
      building: eb.trim(), category, floor: ef, wing: ew || null, section: es || null,
      unit: eu.trim(), normalized_key: nk,
      updated_at: new Date().toISOString(),
    }).eq("id", slot.id);
    if (error) { alert(error.message); return; }
    setEditSlot(false); onUpdate();
  }

  return (
    <Modal size="2xl" onClose={onClose}>
      <div className="p-5">
        <div className="flex items-start justify-between mb-3">
          <div>
            {editSlot ? (
              <div className="grid grid-cols-5 gap-2 mb-2">
                <input value={eb} onChange={e => setEb(e.target.value)} className="border rounded px-2 py-1 text-sm" placeholder="건물" />
                <select value={ef} onChange={e => setEf(parseInt(e.target.value, 10))} className="border rounded px-2 py-1 text-sm">
                  {floorOpts.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
                <select value={ew} onChange={e => setEw(e.target.value)} className="border rounded px-2 py-1 text-sm">
                  <option value="">(없음)</option>
                  {wingOpts.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
                <select value={es} onChange={e => setEs(e.target.value)} className="border rounded px-2 py-1 text-sm">
                  <option value="">(없음)</option>
                  {sectionOpts.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
                <input value={eu} onChange={e => setEu(e.target.value)} className="border rounded px-2 py-1 text-sm" placeholder="호" />
              </div>
            ) : (
              <h3 className="text-lg font-bold text-gray-800">
                {slot.building} {floorLabel(slot.floor)}
                {slot.wing ? ` ${slot.wing}` : ""}
                {slot.section ? ` ${sectionLabel(slot.section)}열` : ""} {slot.unit}호
              </h3>
            )}
            <div className="text-xs text-gray-400 mt-1 font-mono">{slot.normalized_key}</div>
          </div>
          <div className="flex gap-1">
            {editSlot ? (
              <>
                <button onClick={saveSlot} className="px-2 py-1 bg-primary text-white text-xs rounded">저장</button>
                <button onClick={() => setEditSlot(false)} className="px-2 py-1 border border-gray-300 text-xs rounded">취소</button>
              </>
            ) : (
              <>
                <button onClick={() => setEditSlot(true)} className="px-2 py-1 border border-gray-300 text-xs rounded">슬롯편집</button>
                <button onClick={deleteSlot} className="px-2 py-1 border border-red-300 text-red-600 text-xs rounded">슬롯삭제</button>
              </>
            )}
          </div>
        </div>

        <div className="border-t border-gray-200 pt-3">
          <div className="flex items-center justify-between mb-2">
            <h4 className="text-sm font-semibold text-gray-700">매장 이력 ({stores.length})</h4>
            <button onClick={() => setAddOpen(true)}
              className="text-xs text-primary hover:underline">+ 매장 추가</button>
          </div>
          {loading ? <div className="text-gray-400 text-sm">로딩...</div> : (
            <table className="w-full text-sm">
              <thead className="bg-gray-50">
                <tr>
                  <Th>순서</Th><Th>매장명</Th><Th>전화</Th><Th>스마트폰</Th><Th>상태</Th><Th></Th>
                </tr>
              </thead>
              <tbody>
                {stores.length === 0 && (
                  <tr><td colSpan={6} className="text-center py-6 text-gray-400">매장 없음</td></tr>
                )}
                {stores.map(s => (
                  <tr key={s.id} className="border-b border-gray-100">
                    {editingId === s.id ? (
                      <StoreEditRow store={s} onCancel={() => setEditingId(null)}
                        onSaved={() => { setEditingId(null); fetchStores(); onUpdate(); }} />
                    ) : (
                      <>
                        <Td className="text-gray-500">{s.store_order}</Td>
                        <Td className={`font-medium ${s.is_hidden ? "text-gray-300 line-through" : ""}`}>{s.store_name}</Td>
                        <Td className="text-gray-600 text-xs">{s.phone || ""}</Td>
                        <Td className="text-gray-600 text-xs">{s.smartphone || ""}</Td>
                        <Td>
                          {s.is_current && <span className="text-xs px-1.5 py-0.5 bg-blue-100 text-blue-700 rounded">current</span>}
                          {s.is_hidden && <span className="text-xs px-1.5 py-0.5 bg-gray-100 text-gray-500 rounded ml-1">hidden</span>}
                        </Td>
                        <Td>
                          <div className="flex gap-1 text-xs">
                            {!s.is_current && <button onClick={() => setCurrent(s.id)} className="text-blue-600 hover:underline">current</button>}
                            <button onClick={() => setEditingId(s.id)} className="text-gray-600 hover:underline">편집</button>
                            <button onClick={() => toggleHidden(s)} className="text-gray-600 hover:underline">{s.is_hidden ? "표시" : "숨김"}</button>
                            <button onClick={() => deleteStore(s.id)} className="text-red-600 hover:underline">삭제</button>
                          </div>
                        </Td>
                      </>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {addOpen && (
          <StoreAddRow slotId={slot.id} nextOrder={(stores[stores.length - 1]?.store_order || 0) + 1}
            onClose={() => setAddOpen(false)}
            onSaved={() => { setAddOpen(false); fetchStores(); onUpdate(); }} />
        )}
      </div>
    </Modal>
  );
}

function StoreEditRow({ store, onCancel, onSaved }: { store: SlotStore; onCancel: () => void; onSaved: () => void }) {
  const [name, setName] = useState(store.store_name);
  const [phone, setPhone] = useState(store.phone || "");
  const [smart, setSmart] = useState(store.smartphone || "");
  async function save() {
    await supabase.from("slot_stores").update({
      store_name: name, phone: phone || null, smartphone: smart || null,
      updated_at: new Date().toISOString(),
    }).eq("id", store.id);
    onSaved();
  }
  return (
    <>
      <Td className="text-gray-500">{store.store_order}</Td>
      <Td><input value={name} onChange={e => setName(e.target.value)} className="border rounded px-2 py-1 text-xs w-full" /></Td>
      <Td><input value={phone} onChange={e => setPhone(e.target.value)} className="border rounded px-2 py-1 text-xs w-full" placeholder="02-..." /></Td>
      <Td><input value={smart} onChange={e => setSmart(e.target.value)} className="border rounded px-2 py-1 text-xs w-full" placeholder="010-..." /></Td>
      <Td></Td>
      <Td>
        <div className="flex gap-1 text-xs">
          <button onClick={save} className="text-primary hover:underline">저장</button>
          <button onClick={onCancel} className="text-gray-500 hover:underline">취소</button>
        </div>
      </Td>
    </>
  );
}

function StoreAddRow({ slotId, nextOrder, onClose, onSaved }:
  { slotId: string; nextOrder: number; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [smart, setSmart] = useState("");
  async function save() {
    const trimmed = name.trim();
    if (!trimmed) { alert("매장명 필수"); return; }
    // 같은 슬롯에 동명 매장 (hidden 제외) 이미 있으면 confirm
    const { data: dup } = await supabase.from("slot_stores")
      .select("id, is_current, is_hidden")
      .eq("slot_id", slotId).eq("store_name", trimmed).eq("is_hidden", false);
    if (dup && dup.length > 0) {
      const isCur = dup.some(d => d.is_current);
      const msg = isCur
        ? `"${trimmed}" 매장이 이미 current 로 등록되어 있습니다. 그래도 새 row 추가할까요?`
        : `"${trimmed}" 매장이 이미 ${dup.length}개 등록되어 있습니다. 그래도 추가할까요?`;
      if (!confirm(msg)) return;
    }
    // 새 매장 추가 시 기존 current 끄기 + 새 매장 current
    await supabase.from("slot_stores").update({ is_current: false }).eq("slot_id", slotId);
    await supabase.from("slot_stores").insert({
      slot_id: slotId, store_name: trimmed,
      phone: phone || null, smartphone: smart || null,
      store_order: nextOrder, is_current: true,
    });
    onSaved();
  }
  return (
    <div className="mt-3 p-3 bg-gray-50 rounded border border-gray-200">
      <div className="text-xs font-semibold text-gray-600 mb-2">새 매장 추가 (current 로 박제)</div>
      <div className="grid grid-cols-3 gap-2">
        <input value={name} onChange={e => setName(e.target.value)} placeholder="매장명 *" autoFocus
          className="border rounded px-2 py-1.5 text-sm" />
        <input value={phone} onChange={e => setPhone(e.target.value)} placeholder="전화 (02-...)"
          className="border rounded px-2 py-1.5 text-sm" />
        <input value={smart} onChange={e => setSmart(e.target.value)} placeholder="스마트폰 (010-...)"
          className="border rounded px-2 py-1.5 text-sm" />
      </div>
      <div className="flex gap-2 mt-2 justify-end">
        <button onClick={onClose} className="px-3 py-1 text-sm text-gray-600 hover:underline">취소</button>
        <button onClick={save} className="px-3 py-1 bg-primary text-white text-sm rounded">추가</button>
      </div>
    </div>
  );
}

// === 신규 슬롯 추가 ===
const CUSTOM_BUILDING = "__custom__";
function SlotAddModal({ buildingDefs, floorOpts, wingOpts, sectionOpts, onClose, onUpdate }:
  { buildingDefs: BuildingDef[]; floorOpts: FieldOpt[]; wingOpts: FieldOpt[]; sectionOpts: FieldOpt[]; onClose: () => void; onUpdate: () => void }) {
  // dropdown 옵션: slot_buildings 정의 (+ 직접 입력)
  const dropdownOptions = buildingDefs.map(b => b.name);

  const [buildingSelect, setBuildingSelect] = useState("");
  const [buildingCustom, setBuildingCustom] = useState("");
  const [customCategory, setCustomCategory] = useState("");
  const categories = Array.from(new Set(buildingDefs.map(b => b.category)));
  const [floor, setFloor] = useState(1);
  const [wing, setWing] = useState("");
  const [section, setSection] = useState("");
  const [unit, setUnit] = useState("");
  const [saving, setSaving] = useState(false);

  const building = buildingSelect === CUSTOM_BUILDING ? buildingCustom.trim() : buildingSelect;

  async function save() {
    if (!building || !unit.trim()) { alert("건물명과 호수 필수"); return; }
    // 직접입력 건물 = 카테고리 필수 (slot_buildings 등록용)
    let category = buildingDefs.find(b => b.name === building)?.category ?? null;
    if (buildingSelect === CUSTOM_BUILDING) {
      if (!customCategory) { alert("새 건물은 카테고리를 선택하세요"); return; }
      category = customCategory;
    }
    const nk = `${building}:${floor}:${wing || "-"}:${section || "-"}:${unit.trim()}`;
    // 1) 중복 검증 — normalized_key 가 이미 있으면 거부
    setSaving(true);
    const { data: existing } = await supabase.from("slots").select("id").eq("normalized_key", nk).maybeSingle();
    if (existing) {
      setSaving(false);
      alert(`이미 같은 슬롯이 존재합니다.\n${nk}`);
      return;
    }
    // 2) cap 검증
    const cap = floor < 0 ? 80 : 55;
    const n = parseInt(unit, 10);
    if (!isNaN(n) && n > cap) {
      if (!confirm(`${floorLabel(floor)} cap ${cap} 초과 (${n}호). 계속 추가할까요?`)) {
        setSaving(false); return;
      }
    }
    // 직접입력 건물 → slot_buildings 에 먼저 등록 (있으면 무시) → 다음 등록 시 dropdown 에 노출
    if (buildingSelect === CUSTOM_BUILDING) {
      await supabase.from("slot_buildings").upsert({ name: building, category, user_addable: true }, { onConflict: "name", ignoreDuplicates: true });
    }
    const { error } = await supabase.from("slots").insert({
      building, category, floor, wing: wing || null, section: section || null,
      unit: unit.trim(), normalized_key: nk, is_physical: true,
    });
    setSaving(false);
    if (error) { alert(error.message); return; }
    onClose(); onUpdate();
  }

  return (
    <Modal size="xl" onClose={onClose}>
      <div className="p-5">
        <h3 className="text-lg font-bold text-gray-800 mb-4">신규 슬롯 추가</h3>
        <div className="space-y-3">
          <Field label="건물명 *">
            <select value={buildingSelect} onChange={e => setBuildingSelect(e.target.value)}
              className="w-full border border-gray-300 rounded px-2 py-1.5 text-sm">
              <option value="">선택...</option>
              {dropdownOptions.map(b => <option key={b} value={b}>{b}</option>)}
              <option value={CUSTOM_BUILDING}>+ 직접 입력</option>
            </select>
            {buildingSelect === CUSTOM_BUILDING && (
              <>
                <input value={buildingCustom} onChange={e => setBuildingCustom(e.target.value)}
                  placeholder="새 건물명 입력" autoFocus
                  className="w-full border border-gray-300 rounded px-2 py-1.5 text-sm mt-2" />
                <select value={customCategory} onChange={e => setCustomCategory(e.target.value)}
                  className="w-full border border-gray-300 rounded px-2 py-1.5 text-sm mt-2">
                  <option value="">카테고리 선택...</option>
                  {categories.map(c => <option key={c} value={c}>{c}</option>)}
                </select>
              </>
            )}
          </Field>
          <Field label="층 *">
            <select value={floor} onChange={e => setFloor(parseInt(e.target.value, 10))}
              className="w-full border border-gray-300 rounded px-2 py-1.5 text-sm">
              {floorOpts.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </Field>
          <Field label="구분">
            <select value={wing} onChange={e => setWing(e.target.value)}
              className="w-full border border-gray-300 rounded px-2 py-1.5 text-sm">
              <option value="">(없음)</option>
              {wingOpts.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </Field>
          <Field label="열">
            <select value={section} onChange={e => setSection(e.target.value)}
              className="w-full border border-gray-300 rounded px-2 py-1.5 text-sm">
              <option value="">(없음)</option>
              {sectionOpts.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </Field>
          <Field label="호 *">
            <input value={unit} onChange={e => setUnit(e.target.value)} placeholder="예: 1, 01, 5-1, B"
              className="w-full border border-gray-300 rounded px-2 py-1.5 text-sm" />
          </Field>
        </div>
        <div className="flex gap-2 justify-end mt-5">
          <button onClick={onClose} disabled={saving}
            className="px-4 py-2 border border-gray-300 rounded text-sm disabled:opacity-50">취소</button>
          <button onClick={save} disabled={saving}
            className="px-4 py-2 bg-primary text-white rounded text-sm disabled:opacity-50">
            {saving ? "확인 중..." : "추가"}
          </button>
        </div>
      </div>
    </Modal>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-xs font-semibold text-gray-600 mb-1">{label}</label>
      {children}
    </div>
  );
}
