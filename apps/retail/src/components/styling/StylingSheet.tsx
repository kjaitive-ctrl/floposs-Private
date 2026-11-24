"use client";

import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import { styles } from "@/common/styles";
import { addOrderItem } from "@/lib/purchaseOrder";
import { formatComma, parseDigits } from "@/lib/format";
import { uploadStylingImage, deleteR2Key, imageFromDataTransfer } from "@/lib/stylingImage";

// 스타일링 시트 — 줄 = 코디 1벌. 메모 + 6칸(하의/상의·이너/상의·아우터/아우터/소품·가방/신발).
// 칸마다 후보 샘플 1개: 매장명·상품명·컬러·단가. 칸에서 나오면 자동 저장.
// [주문서로] → 주문 탭에 "샘플요청" 줄로 등록(수량 1). 입고되면 주문 탭에서 샘플 탭으로 자동 등록. 마이그 242.

const SLOTS = [
  { key: "bottom", label: "하의" },
  { key: "top_inner", label: "상의/이너" },
  { key: "top_outer", label: "상의/아우터" },
  { key: "outer", label: "아우터" },
  { key: "acc", label: "소품/가방" },
  { key: "shoes", label: "신발" },
] as const;
type SlotKey = typeof SLOTS[number]["key"];
// 덜 중요한 칸 — 사진·칸 폭을 작게
const MINOR_SLOTS = new Set<SlotKey>(["acc", "shoes"]);

type Look = { id: string; memo: string; sort_order: number };
type Cell = {
  id: string; look_id: string; slot: SlotKey;
  store_name: string | null; product_name: string | null; color: string | null; unit_price: number | null;
  order_item_id: string | null;
  image_key: string | null; image_url: string | null;  // 마이그 244 — 후보 샘플 사진 1장 (R2)
};
const CELL_COLS = "id,look_id,slot,store_name,product_name,color,unit_price,order_item_id,image_key,image_url";
type OrderState = { received_quantity: number | null; sample_product_id: string | null };
type CellField = "store_name" | "product_name" | "color" | "unit_price";

const hasContent = (c?: Cell) => !!(c && (c.store_name?.trim() || c.product_name?.trim()));

export default function StylingSheet({ tenantId }: { tenantId: string }) {
  const [looks, setLooks] = useState<Look[]>([]);
  const [cells, setCells] = useState<Record<string, Cell>>({}); // `${look_id}:${slot}`
  const [orders, setOrders] = useState<Record<string, OrderState>>({}); // order_item_id → 상태
  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState<{ text: string; error?: boolean } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [uploading, setUploading] = useState<string | null>(null); // `${look}:${slot}`
  const [preview, setPreview] = useState<string | null>(null);      // 크게 보기 URL
  const [resets, setResets] = useState<Record<string, number>>({}); // [비우기]·칸 옮기기 후 입력칸 다시 그리기용
  const [dragCell, setDragCell] = useState<Cell | null>(null);      // 끌고 있는 칸
  const [dropKey, setDropKey] = useState<string | null>(null);      // 놓을 자리 표시 `${look}:${slot}`

  const load = useCallback(async () => {
    const { data: ls, error: e1 } = await supabase.from("styling_looks")
      .select("id,memo,sort_order").eq("tenant_id", tenantId).is("deleted_at", null).order("sort_order");
    if (e1) { setMsg({ text: `불러오기 실패: ${e1.message}`, error: true }); setLoading(false); return; }
    const ids = (ls ?? []).map(l => l.id);
    const map: Record<string, Cell> = {};
    const ordMap: Record<string, OrderState> = {};
    if (ids.length) {
      const { data: cs, error: e2 } = await supabase.from("styling_cells")
        .select(CELL_COLS).in("look_id", ids);
      if (e2) { setMsg({ text: `불러오기 실패: ${e2.message}`, error: true }); setLoading(false); return; }
      (cs ?? []).forEach(c => { map[`${c.look_id}:${c.slot}`] = c as Cell; });
      const oids = (cs ?? []).map(c => c.order_item_id).filter(Boolean) as string[];
      if (oids.length) {
        const { data: os } = await supabase.from("purchase_order_items")
          .select("id,received_quantity,sample_product_id").in("id", oids);
        (os ?? []).forEach(o => { ordMap[o.id] = { received_quantity: o.received_quantity, sample_product_id: o.sample_product_id }; });
      }
    }
    setLooks(ls ?? []);
    setCells(map);
    setOrders(ordMap);
    setLoading(false);
  }, [tenantId]);

  useEffect(() => { load(); }, [load]);

  async function addLook() {
    const next = (looks.at(-1)?.sort_order ?? 0) + 10;
    const { data, error } = await supabase.from("styling_looks")
      .insert({ tenant_id: tenantId, memo: "", sort_order: next }).select("id,memo,sort_order").single();
    if (error || !data) { setMsg({ text: `코디 추가 실패: ${error?.message}`, error: true }); return; }
    setLooks(prev => [...prev, data]);
  }

  async function saveMemo(look: Look, memo: string) {
    if (memo === look.memo) return;
    setLooks(prev => prev.map(l => l.id === look.id ? { ...l, memo } : l));
    const { error } = await supabase.from("styling_looks")
      .update({ memo, updated_at: new Date().toISOString() }).eq("id", look.id);
    if (error) setMsg({ text: `메모 저장 실패: ${error.message}`, error: true });
  }

  async function removeLook(look: Look) {
    if (!confirm("이 코디 줄을 삭제할까요? (이미 주문서로 보낸 줄은 주문 탭에 그대로 남습니다)")) return;
    setLooks(prev => prev.filter(l => l.id !== look.id));
    const { error } = await supabase.from("styling_looks")
      .update({ deleted_at: new Date().toISOString() }).eq("id", look.id);
    if (error) setMsg({ text: `삭제 실패: ${error.message}`, error: true });
  }

  // 칸 저장 — 있으면 고치고 없으면 만듦. UNIQUE(look_id, slot) 이 DEFERRABLE(마이그 245)이라
  // upsert(ON CONFLICT)는 쓸 수 없음. 동시에 만들어져 중복(23505)이면 그 칸을 고침.
  async function writeCell(lookId: string, slot: SlotKey, patch: Partial<Pick<Cell, CellField>>) {
    const fields = { ...patch, updated_at: new Date().toISOString() };
    const update = () => supabase.from("styling_cells").update(fields)
      .eq("look_id", lookId).eq("slot", slot).select(CELL_COLS).maybeSingle();
    const updated = await update();
    if (updated.error || updated.data) return updated;
    const inserted = await supabase.from("styling_cells")
      .insert({ tenant_id: tenantId, look_id: lookId, slot, ...fields }).select(CELL_COLS).single();
    return inserted.error?.code === "23505" ? update() : inserted;
  }

  async function saveCell(lookId: string, slot: SlotKey, field: CellField, raw: string) {
    const k = `${lookId}:${slot}`;
    const cur = cells[k];
    const value: string | number | null = field === "unit_price"
      ? (parseDigits(raw) ? Number(parseDigits(raw)) : null)
      : (raw.trim() || null);
    if ((cur?.[field] ?? null) === value) return;
    if (!cur && value === null) return;
    const { data, error } = await writeCell(lookId, slot, { [field]: value });
    if (error || !data) { setMsg({ text: `저장 실패: ${error?.message}`, error: true }); return; }
    setCells(prev => ({ ...prev, [k]: data as Cell }));
  }

  // ── 후보 샘플 사진 (칸마다 1장, R2) — 붙여넣기(Ctrl+V)·끌어놓기·앨범 선택 ──
  async function ensureCell(lookId: string, slot: SlotKey): Promise<Cell | null> {
    const cur = cells[`${lookId}:${slot}`];
    if (cur) return cur;
    const { data, error } = await writeCell(lookId, slot, {});
    if (error || !data) { setMsg({ text: `칸 만들기 실패: ${error?.message}`, error: true }); return null; }
    setCells(prev => ({ ...prev, [`${lookId}:${slot}`]: data as Cell }));
    return data as Cell;
  }

  async function setImage(lookId: string, slot: SlotKey, file: File | null) {
    if (!file || !file.type.startsWith("image/")) return;
    const k = `${lookId}:${slot}`;
    if (uploading) return;
    setUploading(k);
    setMsg(null);
    try {
      const cell = await ensureCell(lookId, slot);
      if (!cell) return;
      const { key, url } = await uploadStylingImage(cell.id, file);
      const { data, error } = await supabase.from("styling_cells")
        .update({ image_key: key, image_url: url, updated_at: new Date().toISOString() })
        .eq("id", cell.id).select(CELL_COLS).single();
      if (error || !data) { deleteR2Key(key); setMsg({ text: `사진 저장 실패: ${error?.message}`, error: true }); return; }
      setCells(prev => ({ ...prev, [k]: data as Cell }));
      if (cell.image_key && cell.image_key !== key) deleteR2Key(cell.image_key); // 바꾼 사진의 옛 파일 정리
    } catch (e) {
      setMsg({ text: `사진 올리기 실패: ${e instanceof Error ? e.message : String(e)}`, error: true });
    } finally {
      setUploading(null);
    }
  }

  async function removeImage(cell: Cell) {
    if (!cell.image_key || !confirm("이 사진을 지울까요?")) return;
    const { error } = await supabase.from("styling_cells")
      .update({ image_key: null, image_url: null, updated_at: new Date().toISOString() }).eq("id", cell.id);
    if (error) { setMsg({ text: `사진 삭제 실패: ${error.message}`, error: true }); return; }
    setCells(prev => ({ ...prev, [`${cell.look_id}:${cell.slot}`]: { ...cell, image_key: null, image_url: null } }));
    deleteR2Key(cell.image_key);
  }

  // [비우기] — 칸 하나 통째로 (글자 4개 + 사진). 주문서로 보낸 칸은 대상 아님 (주문 탭에서 줄 삭제하면 풀림)
  async function clearCell(cell: Cell) {
    if (cell.order_item_id) return;
    if (!confirm("이 칸을 비울까요? (매장명·상품명·컬러·단가·사진 전부)")) return;
    const k = `${cell.look_id}:${cell.slot}`;
    const { error } = await supabase.from("styling_cells").delete().eq("id", cell.id);
    if (error) { setMsg({ text: `비우기 실패: ${error.message}`, error: true }); return; }
    setCells(prev => { const next = { ...prev }; delete next[k]; return next; });
    setResets(prev => ({ ...prev, [k]: (prev[k] ?? 0) + 1 }));
    if (cell.image_key) deleteR2Key(cell.image_key);
  }

  // 코디 순서 바꾸기 — 위/아래 줄과 sort_order 맞바꿈
  async function moveLook(look: Look, dir: -1 | 1) {
    const i = looks.findIndex(l => l.id === look.id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= looks.length) return;
    const other = looks[j];
    const next = [...looks];
    next[i] = { ...other, sort_order: look.sort_order };
    next[j] = { ...look, sort_order: other.sort_order };
    // 같은 sort_order 였던 경우 대비: 서로 다른 값 보장
    if (next[i].sort_order === next[j].sort_order) next[j].sort_order += dir;
    setLooks(next);
    const now = new Date().toISOString();
    const [r1, r2] = await Promise.all([
      supabase.from("styling_looks").update({ sort_order: next[j].sort_order, updated_at: now }).eq("id", look.id),
      supabase.from("styling_looks").update({ sort_order: next[i].sort_order, updated_at: now }).eq("id", other.id),
    ]);
    if (r1.error || r2.error) { setMsg({ text: `순서 저장 실패: ${(r1.error || r2.error)?.message}`, error: true }); load(); }
  }

  // 칸 옮기기 (끌어다 놓기) — 같은 열끼리만. 놓은 자리에 칸이 있으면 맞바꿈, 없으면 옮기기만.
  // 칸 id 는 그대로라 주문 탭 연결·사진도 같이 따라감. DB 함수 styling_move_cell (마이그 245).
  async function moveCell(cell: Cell, targetLookId: string) {
    if (cell.look_id === targetLookId) return;
    const from = `${cell.look_id}:${cell.slot}`;
    const to = `${targetLookId}:${cell.slot}`;
    const other = cells[to];
    const bump = () => setResets(prev => ({ ...prev, [from]: (prev[from] ?? 0) + 1, [to]: (prev[to] ?? 0) + 1 }));
    setCells(prev => {
      const next = { ...prev };
      delete next[from];
      delete next[to];
      next[to] = { ...cell, look_id: targetLookId };
      if (other) next[from] = { ...other, look_id: cell.look_id };
      return next;
    });
    bump();
    setMsg(null);
    const { error } = await supabase.rpc("styling_move_cell", { p_cell_id: cell.id, p_target_look_id: targetLookId });
    if (error) {
      const missing = /styling_move_cell|function|schema cache/i.test(error.message);
      setMsg({ text: missing ? "칸 옮기기 준비 중 (마이그 245 적용 필요)" : `칸 옮기기 실패: ${error.message}`, error: true });
      await load();
      bump();
    }
  }

  // [주문서로] — 상품(칸) 하나 또는 코디 줄 전체. 아직 안 보낸 칸만 주문 탭에 샘플요청 줄로 (수량 1)
  async function sendToOrder(look: Look, only?: SlotKey) {
    const targets = SLOTS.filter(s => !only || s.key === only)
      .map(s => cells[`${look.id}:${s.key}`]).filter(c => hasContent(c) && !c!.order_item_id) as Cell[];
    if (targets.length === 0) { setMsg({ text: "주문서로 보낼 칸이 없습니다 (매장명이나 상품명이 있는 칸, 아직 안 보낸 칸만)" }); return; }
    setBusy(only ? `${look.id}:${only}` : look.id);
    let sent = 0;
    for (const c of targets) {
      const name = c.product_name?.trim() || null;
      const { item, error } = await addOrderItem(tenantId, {
        product_name: name,
        wholesale_name: name,
        supplier_name: c.store_name?.trim() || null,
        variant_label: c.color?.trim() || null,
        unit_price: c.unit_price ?? 0,
        quantity: 1,
        is_sample_request: true,
        styling_cell_id: c.id,
      });
      if (error || !item) { setMsg({ text: `주문서 등록 실패: ${error}`, error: true }); break; }
      const { error: e2 } = await supabase.from("styling_cells").update({ order_item_id: item.id }).eq("id", c.id);
      if (e2) { setMsg({ text: `연결 저장 실패: ${e2.message}`, error: true }); break; }
      setCells(prev => ({ ...prev, [`${c.look_id}:${c.slot}`]: { ...c, order_item_id: item.id } }));
      setOrders(prev => ({ ...prev, [item.id]: { received_quantity: null, sample_product_id: null } }));
      sent++;
    }
    setBusy(null);
    if (sent) setMsg({ text: `주문 탭에 샘플요청 ${sent}줄 등록 — 입고하면 샘플 탭으로 넘어갑니다` });
  }

  function badge(c?: Cell) {
    if (!c?.order_item_id) return null;
    const o = orders[c.order_item_id];
    if (o?.sample_product_id) return <span className="text-[10px] px-1 rounded bg-emerald-50 text-emerald-700">샘플 등록됨</span>;
    if (o && (o.received_quantity ?? 0) > 0) return <span className="text-[10px] px-1 rounded bg-emerald-50 text-emerald-700">입고</span>;
    return <span className="text-[10px] px-1 rounded bg-yellow-100 text-yellow-800">주문됨</span>;
  }

  if (loading) return <div className="text-xs text-gray-400">불러오는 중…</div>;

  const inputCls = "w-full h-7 px-1.5 text-xs bg-transparent text-black placeholder:text-gray-400 focus:outline-none focus:bg-white focus:ring-1 focus:ring-black focus:ring-inset";

  return (
    <div>
      <div className="flex items-center gap-3 mb-4">
        <h1 className={styles.headerTitle}>스타일링</h1>
        <span className="text-xs text-gray-400">줄 = 코디 1벌 · 칸마다 후보 샘플 (매장명·상품명·컬러·단가) · [주문서로] → 주문 탭 샘플요청 → 입고 시 샘플 탭 등록 · 칸 왼쪽 아래 ⠿ 를 끌어 다른 코디의 같은 칸에 놓으면 서로 바뀜</span>
      </div>
      {msg && <div className={(msg.error ? styles.msgError : styles.msgOk) + " mb-3"}>{msg.text}</div>}

      <div className="overflow-x-auto border-l border-t border-gray-300">
        <table className="border-collapse text-xs">
          <thead>
            <tr>
              <th rowSpan={2} className="min-w-[14rem] bg-gray-200 border-b border-r border-gray-300 font-semibold">메모</th>
              <th colSpan={SLOTS.length} className="h-7 bg-yellow-300 border-b border-r border-gray-300 font-semibold">스타일링</th>
              <th rowSpan={2} className="min-w-[6rem] bg-gray-100 border-b border-r border-gray-300 font-medium">주문</th>
            </tr>
            <tr>
              {SLOTS.map(s => (
                <th key={s.key} className={(MINOR_SLOTS.has(s.key) ? "min-w-[14rem]" : "min-w-[19rem]") + " h-7 bg-yellow-200 border-b border-r border-gray-300 font-semibold"}>{s.label}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {looks.map((look, idx) => (
              <tr key={look.id} className="align-top">
                <td className="p-0 border-b border-r border-gray-300 relative group">
                  <div className="flex h-full">
                    {/* 순서 바꾸기 */}
                    <div className="flex flex-col justify-center border-r border-gray-200 bg-gray-50">
                      <button type="button" disabled={idx === 0} onClick={() => moveLook(look, -1)} title="위로"
                        className="px-1 text-[10px] text-gray-400 hover:text-black disabled:opacity-20">▲</button>
                      <span className="text-[10px] text-gray-400 text-center">{idx + 1}</span>
                      <button type="button" disabled={idx === looks.length - 1} onClick={() => moveLook(look, 1)} title="아래로"
                        className="px-1 text-[10px] text-gray-400 hover:text-black disabled:opacity-20">▼</button>
                    </div>
                    <textarea defaultValue={look.memo} placeholder="메모"
                      onBlur={e => saveMemo(look, e.currentTarget.value)}
                      className="flex-1 h-[6.75rem] px-1.5 py-1 text-xs bg-transparent text-black resize-none focus:outline-none focus:bg-white focus:ring-1 focus:ring-black focus:ring-inset" />
                  </div>
                  <button type="button" onClick={() => removeLook(look)} title="이 코디 줄 삭제"
                    className="absolute right-1 bottom-1 hidden group-hover:block text-gray-400 hover:text-red-600">✕</button>
                </td>
                {SLOTS.map(s => {
                  const c = cells[`${look.id}:${s.key}`];
                  const locked = !!c?.order_item_id; // 주문서로 보낸 칸은 주문 탭에서 고침
                  // 사진 크기: 주요 4칸(하의~아우터) 크게, 소품·가방/신발은 작게
                  const photo = MINOR_SLOTS.has(s.key) ? "w-[4.5rem] h-[4.5rem]" : "w-[6.75rem] h-[6.75rem]";
                  const k = `${look.id}:${s.key}`;
                  // 끌고 있는 칸을 놓을 수 있는 자리 = 같은 열, 다른 코디 줄
                  const canDrop = !!dragCell && dragCell.slot === s.key && dragCell.look_id !== look.id;
                  return (
                    <td key={s.key}
                      onPaste={e => { const f = imageFromDataTransfer(e.clipboardData); if (f) { e.preventDefault(); setImage(look.id, s.key, f); } }}
                      onDragOver={e => {
                        if (Array.from(e.dataTransfer.types).includes("Files")) { e.preventDefault(); return; }
                        if (canDrop) { e.preventDefault(); e.dataTransfer.dropEffect = "move"; if (dropKey !== k) setDropKey(k); }
                      }}
                      onDragLeave={e => { if (dropKey === k && !e.currentTarget.contains(e.relatedTarget as Node | null)) setDropKey(null); }}
                      onDrop={e => {
                        if (dragCell) {
                          e.preventDefault();
                          const moving = dragCell;
                          setDragCell(null);
                          setDropKey(null);
                          if (canDrop) moveCell(moving, look.id);
                          return;
                        }
                        const f = imageFromDataTransfer(e.dataTransfer); if (f) { e.preventDefault(); setImage(look.id, s.key, f); }
                      }}
                      className={"p-0 border-b border-r border-gray-300 "
                        + (dropKey === k ? "bg-sky-100 ring-2 ring-sky-500 ring-inset"
                          : dragCell?.id && c?.id === dragCell.id ? "opacity-40 bg-amber-50/60"
                          : locked ? "bg-yellow-50" : "bg-amber-50/60")}>
                      <div className="flex">
                      {/* 사진 칸: 비었으면 눌러서 앨범 선택 / 칸 안에서 Ctrl+V / 끌어놓기 */}
                      <div className={"relative shrink-0 border-r border-b border-amber-100 group/img " + photo}>
                        {uploading === `${look.id}:${s.key}` ? (
                          <div className="h-full flex items-center justify-center text-[10px] text-gray-500">올리는 중…</div>
                        ) : c?.image_url ? (
                          <>
                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            <img src={c.image_url} alt="" onClick={() => setPreview(c.image_url)}
                              className="w-full h-full object-cover cursor-zoom-in" />
                            <button type="button" onClick={() => removeImage(c)} title="사진 삭제"
                              className="absolute top-0 right-0 hidden group-hover/img:block bg-white/90 text-gray-500 hover:text-red-600 text-[10px] px-1">✕</button>
                          </>
                        ) : (
                          // 누르면 이 자리가 선택됨 → 바로 Ctrl+V (파일 선택 창은 아래 [파일] 버튼)
                          <div tabIndex={0} title="누른 뒤 Ctrl+V 로 캡처 붙여넣기 · 끌어놓기도 됨"
                            className="h-full flex flex-col items-center justify-center text-[10px] text-gray-400 cursor-pointer hover:bg-white focus:outline-none focus:ring-2 focus:ring-black focus:ring-inset focus:bg-white focus:text-black">
                            <span>사진</span>
                            <span>Ctrl+V</span>
                          </div>
                        )}
                      </div>
                      <div key={resets[`${look.id}:${s.key}`] ?? 0} className="grid grid-cols-[1fr_5rem] flex-1 min-w-0">
                        <input defaultValue={c?.store_name ?? ""} placeholder="매장명" disabled={locked}
                          onBlur={e => saveCell(look.id, s.key, "store_name", e.currentTarget.value)} className={inputCls + " border-b border-r border-amber-100"} />
                        <input defaultValue={c?.color ?? ""} placeholder="컬러" disabled={locked}
                          onBlur={e => saveCell(look.id, s.key, "color", e.currentTarget.value)} className={inputCls + " border-b border-amber-100"} />
                        <input defaultValue={c?.product_name ?? ""} placeholder="상품명" disabled={locked}
                          onBlur={e => saveCell(look.id, s.key, "product_name", e.currentTarget.value)} className={inputCls + " border-b border-r border-amber-100"} />
                        <input defaultValue={c?.unit_price != null ? formatComma(c.unit_price) : ""} placeholder="단가" disabled={locked}
                          onBlur={e => saveCell(look.id, s.key, "unit_price", e.currentTarget.value)} className={inputCls + " border-b border-amber-100 text-right"} />
                        <div className="col-span-2 h-[1.35rem] px-1.5 flex items-center gap-1">
                          {c && (
                            <span draggable
                              onDragStart={e => { e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("application/x-styling-cell", c.id); setDragCell(c); }}
                              onDragEnd={() => { setDragCell(null); setDropKey(null); }}
                              title={`잡고 다른 코디의 ${s.label} 칸에 놓으면 서로 바뀝니다 (빈 칸이면 옮기기만)`}
                              className="px-1 text-[11px] leading-none text-gray-400 hover:text-black cursor-grab active:cursor-grabbing select-none">⠿</span>
                          )}
                          {badge(c)}
                          {/* 파일 선택 (휴대폰 앨범 등) */}
                          <label title="파일에서 사진 선택"
                            className="px-1.5 text-[10px] border border-gray-300 rounded bg-white text-gray-500 hover:text-black hover:border-black cursor-pointer">
                            파일
                            <input type="file" accept="image/*" className="hidden"
                              onChange={e => { setImage(look.id, s.key, e.currentTarget.files?.[0] ?? null); e.currentTarget.value = ""; }} />
                          </label>
                          {c && !locked && (c.store_name || c.product_name || c.color || c.unit_price != null || c.image_key) && (
                            <button type="button" onClick={() => clearCell(c)} title="이 칸 비우기 (글자·사진 전부)"
                              className="px-1.5 text-[10px] border border-gray-300 rounded bg-white text-gray-500 hover:text-red-600 hover:border-red-600">
                              비우기
                            </button>
                          )}
                          {hasContent(c) && !locked && (
                            <button type="button" disabled={busy === `${look.id}:${s.key}`}
                              onClick={() => sendToOrder(look, s.key)} title="이 상품만 주문 탭에 샘플요청으로"
                              className="ml-auto px-1.5 text-[10px] border border-black rounded bg-white hover:bg-gray-100 disabled:opacity-40">
                              {busy === `${look.id}:${s.key}` ? "…" : "주문서로"}
                            </button>
                          )}
                        </div>
                      </div>
                      </div>
                    </td>
                  );
                })}
                <td className="px-2 py-2 border-b border-r border-gray-300 text-center">
                  <button type="button" disabled={busy === look.id} onClick={() => sendToOrder(look)}
                    className={styles.btnSmall + " bg-white whitespace-nowrap disabled:opacity-40"}>
                    {busy === look.id ? "보내는 중…" : "전부 주문서로"}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <button type="button" onClick={addLook} className="mt-2 px-3 py-1 text-xs border border-gray-300 rounded hover:bg-gray-50">+ 코디 추가</button>

      {/* 사진 크게 보기 */}
      {preview && (
        <div onClick={() => setPreview(null)}
          className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-6 cursor-zoom-out">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={preview} alt="" className="max-w-full max-h-full object-contain bg-white" />
        </div>
      )}
    </div>
  );
}
