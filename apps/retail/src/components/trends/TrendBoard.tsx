"use client";

import { useCallback, useEffect, useRef, useState, KeyboardEvent } from "react";
import { supabase } from "@/lib/supabase";
import { styles } from "@/common/styles";

// 트렌드 보드 — 열 = 시즌(24FW·25FW…), 열 아래 칸 = 키워드. 구글시트처럼 칸 눌러 바로 입력·수정.
// 저장: 칸에서 나올 때(blur)·Enter. 칸을 비우면 그 줄 삭제(소프트삭제, 복구 가능). 마이그 240.

type Season = { id: string; label: string; sort_order: number };
type Item = { id: string; season_id: string; text: string; sort_order: number };
type SaveState = "idle" | "saving" | "saved" | "error";

const COL_W = "w-48 min-w-[12rem]";
const cellBase = "h-8 border-b border-r border-gray-200";

export default function TrendBoard({ tenantId }: { tenantId: string }) {
  const [seasons, setSeasons] = useState<Season[]>([]);
  const [items, setItems] = useState<Record<string, Item[]>>({});
  const [loading, setLoading] = useState(true);
  const [save, setSave] = useState<SaveState>("idle");
  const [error, setError] = useState<string | null>(null);
  const boardRef = useRef<HTMLDivElement>(null);
  const pendingFocus = useRef<{ col: number; row: number } | null>(null);

  const load = useCallback(async () => {
    // loading 초기값 true. 여기서 동기 setState 안 함 (effect 안 연쇄 렌더 방지)
    const { data: s, error: e1 } = await supabase
      .from("trend_seasons").select("id,label,sort_order")
      .eq("tenant_id", tenantId).is("deleted_at", null).order("sort_order");
    if (e1) { setError(e1.message); setLoading(false); return; }
    const ids = (s ?? []).map(x => x.id);
    const grouped: Record<string, Item[]> = {};
    ids.forEach(id => { grouped[id] = []; });
    if (ids.length) {
      const { data: it, error: e2 } = await supabase
        .from("trend_items").select("id,season_id,text,sort_order")
        .in("season_id", ids).is("deleted_at", null).order("sort_order");
      if (e2) { setError(e2.message); setLoading(false); return; }
      (it ?? []).forEach(x => { (grouped[x.season_id] ??= []).push(x); });
    }
    setSeasons(s ?? []);
    setItems(grouped);
    setLoading(false);
  }, [tenantId]);

  useEffect(() => { load(); }, [load]);

  // 렌더 후 예약된 칸으로 커서 이동 (Enter로 새 줄 추가했을 때 등)
  useEffect(() => {
    const p = pendingFocus.current;
    if (!p || !boardRef.current) return;
    pendingFocus.current = null;
    const el = boardRef.current.querySelector<HTMLInputElement>(`[data-col="${p.col}"][data-row="${p.row}"]`);
    el?.focus();
  });

  async function run<T>(fn: () => PromiseLike<{ error: { message: string } | null; data?: T }>) {
    setSave("saving");
    const res = await fn();
    if (res.error) { setSave("error"); setError(res.error.message); return null; }
    setSave("saved"); setError(null);
    return res;
  }

  // ── 시즌 ──
  async function addSeason() {
    const next = (seasons.at(-1)?.sort_order ?? 0) + 10;
    const res = await run(() => supabase.from("trend_seasons")
      .insert({ tenant_id: tenantId, label: "새 시즌", sort_order: next })
      .select("id,label,sort_order").single());
    const row = res?.data as Season | undefined;
    if (!row) return;
    setSeasons(prev => [...prev, row]);
    setItems(prev => ({ ...prev, [row.id]: [] }));
    pendingFocus.current = { col: seasons.length, row: -1 };
  }

  async function renameSeason(s: Season, label: string) {
    const v = label.trim();
    if (!v || v === s.label) return;
    setSeasons(prev => prev.map(x => x.id === s.id ? { ...x, label: v } : x));
    await run(() => supabase.from("trend_seasons")
      .update({ label: v, updated_at: new Date().toISOString() }).eq("id", s.id));
  }

  async function removeSeason(s: Season) {
    const n = items[s.id]?.length ?? 0;
    if (!confirm(`'${s.label}' 시즌을 삭제할까요? 키워드 ${n}개도 같이 숨겨집니다.`)) return;
    setSeasons(prev => prev.filter(x => x.id !== s.id));
    await run(() => supabase.from("trend_seasons")
      .update({ deleted_at: new Date().toISOString() }).eq("id", s.id));
  }

  // ── 키워드 ──
  async function commitItem(seasonId: string, it: Item, text: string) {
    const v = text.trim();
    if (v === it.text) return;
    if (!v) {
      // 비우면 삭제 (소프트)
      setItems(prev => ({ ...prev, [seasonId]: prev[seasonId].filter(x => x.id !== it.id) }));
      await run(() => supabase.from("trend_items")
        .update({ deleted_at: new Date().toISOString() }).eq("id", it.id));
      return;
    }
    setItems(prev => ({ ...prev, [seasonId]: prev[seasonId].map(x => x.id === it.id ? { ...x, text: v } : x) }));
    await run(() => supabase.from("trend_items")
      .update({ text: v, updated_at: new Date().toISOString() }).eq("id", it.id));
  }

  async function addItem(seasonId: string, text: string) {
    const v = text.trim();
    if (!v) return false;
    const list = items[seasonId] ?? [];
    const next = (list.at(-1)?.sort_order ?? 0) + 10;
    const res = await run(() => supabase.from("trend_items")
      .insert({ tenant_id: tenantId, season_id: seasonId, text: v, sort_order: next })
      .select("id,season_id,text,sort_order").single());
    const row = res?.data as Item | undefined;
    if (!row) return false;
    setItems(prev => ({ ...prev, [seasonId]: [...(prev[seasonId] ?? []), row] }));
    return true;
  }

  // ↑↓·Enter 로 같은 열 위아래 이동
  function moveFocus(e: KeyboardEvent<HTMLInputElement>, col: number, row: number) {
    let target: number | null = null;
    if (e.key === "Enter" || e.key === "ArrowDown") target = row + 1;
    else if (e.key === "ArrowUp") target = row - 1;
    if (target === null) return;
    e.preventDefault();
    (e.currentTarget as HTMLInputElement).blur();
    pendingFocus.current = { col, row: target };
    // blur 로 저장이 상태를 바꾸지 않는 경우에도 이동하도록 한 번 더 시도
    setTimeout(() => {
      const p = pendingFocus.current;
      if (!p || !boardRef.current) return;
      const el = boardRef.current.querySelector<HTMLInputElement>(`[data-col="${p.col}"][data-row="${p.row}"]`);
      if (el) { pendingFocus.current = null; el.focus(); }
    }, 0);
  }

  if (loading) return <div className="text-xs text-gray-400">불러오는 중…</div>;

  const maxRows = Math.max(0, ...seasons.map(s => items[s.id]?.length ?? 0)) + 1;

  return (
    <div>
      <div className="flex items-center gap-3 mb-4">
        <h1 className={styles.headerTitle}>트렌드</h1>
        <span className="text-xs text-gray-400">시즌별 트렌드 키워드 · 칸을 눌러 바로 입력, 비우면 삭제</span>
        <span className="ml-auto text-xs">
          {save === "saving" && <span className="text-gray-400">저장 중…</span>}
          {save === "saved" && <span className="text-gray-400">저장됨</span>}
          {save === "error" && <span className="text-red-600">저장 실패: {error}</span>}
        </span>
      </div>
      {error && save !== "error" && <div className={styles.msgError}>{error}</div>}

      <div ref={boardRef} className="overflow-x-auto border-l border-t border-gray-200">
        <div className="flex w-max">
          {seasons.map((s, col) => {
            const list = items[s.id] ?? [];
            return (
              <div key={s.id} className={COL_W}>
                {/* 시즌 이름 */}
                <div className={`${cellBase} group relative bg-gray-100`}>
                  <input
                    defaultValue={s.label}
                    data-col={col} data-row={-1}
                    onBlur={e => renameSeason(s, e.currentTarget.value)}
                    onKeyDown={e => moveFocus(e, col, -1)}
                    className={`${styles.gridInput} h-full text-center font-semibold`}
                  />
                  <button
                    type="button" title="시즌 삭제" onClick={() => removeSeason(s)}
                    className="absolute right-1 top-1/2 -translate-y-1/2 hidden group-hover:block text-gray-400 hover:text-red-600 text-xs px-1"
                  >✕</button>
                </div>
                {/* 키워드 칸 */}
                {Array.from({ length: maxRows }).map((_, row) => {
                  const it = list[row];
                  if (it) {
                    return (
                      <div key={it.id} className={cellBase}>
                        <input
                          defaultValue={it.text}
                          data-col={col} data-row={row}
                          onBlur={e => commitItem(s.id, it, e.currentTarget.value)}
                          onKeyDown={e => moveFocus(e, col, row)}
                          className={`${styles.gridInput} h-full`}
                        />
                      </div>
                    );
                  }
                  if (row === list.length) {
                    return (
                      <div key={`new-${row}`} className={cellBase}>
                        <input
                          placeholder="+ 입력"
                          data-col={col} data-row={row}
                          onBlur={async e => {
                            const el = e.currentTarget;
                            if (await addItem(s.id, el.value)) el.value = "";
                          }}
                          onKeyDown={e => moveFocus(e, col, row)}
                          className={`${styles.gridInput} h-full placeholder:text-gray-300`}
                        />
                      </div>
                    );
                  }
                  return <div key={`empty-${row}`} className={cellBase} />;
                })}
              </div>
            );
          })}
          {/* 시즌 추가 */}
          <div className="w-28 border-b border-r border-gray-200">
            <button type="button" onClick={addSeason}
              className="h-8 w-full text-xs text-gray-500 hover:bg-gray-50 hover:text-black">+ 시즌</button>
          </div>
        </div>
      </div>
    </div>
  );
}
