"use client";

import { useCallback, useEffect, useRef, useState, KeyboardEvent } from "react";
import { supabase } from "@/lib/supabase";

// 엑셀형 자유 메모 — 아무 칸에나 자유롭게 입력. 칸에서 나올 때 자동 저장(비우면 그 칸 삭제).
// 저장: free_sheet_cells (tenant_id + sheet_key + 행/열). 마이그 242.
// 방향키·Enter·Tab 으로 칸 이동. [+ 줄] [+ 열] 로 넓힘.

type CellMap = Record<string, string>; // "r:c" → text
const key = (r: number, c: number) => `${r}:${c}`;
const colName = (c: number) => String.fromCharCode(65 + (c % 26)) + (c >= 26 ? Math.floor(c / 26) : "");

export default function FreeSheet({
  tenantId, sheetKey, title = "메모", minRows = 12, minCols = 6,
}: { tenantId: string; sheetKey: string; title?: string; minRows?: number; minCols?: number }) {
  const [cells, setCells] = useState<CellMap>({});
  const [rows, setRows] = useState(minRows);
  const [cols, setCols] = useState(minCols);
  const [loaded, setLoaded] = useState(false);
  const [status, setStatus] = useState<string>("");
  const ref = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    const { data, error } = await supabase.from("free_sheet_cells")
      .select("row_idx,col_idx,text").eq("tenant_id", tenantId).eq("sheet_key", sheetKey);
    if (error) { setStatus(`불러오기 실패: ${error.message}`); setLoaded(true); return; }
    const m: CellMap = {};
    let maxR = 0, maxC = 0;
    (data ?? []).forEach(d => { m[key(d.row_idx, d.col_idx)] = d.text; maxR = Math.max(maxR, d.row_idx); maxC = Math.max(maxC, d.col_idx); });
    setCells(m);
    setRows(r => Math.max(r, maxR + 3));
    setCols(c => Math.max(c, maxC + 2));
    setLoaded(true);
  }, [tenantId, sheetKey]);

  useEffect(() => { load(); }, [load]);

  async function commit(r: number, c: number, value: string) {
    const v = value.replace(/\s+$/, "");
    if ((cells[key(r, c)] ?? "") === v) return;
    setCells(prev => { const n = { ...prev }; if (v) n[key(r, c)] = v; else delete n[key(r, c)]; return n; });
    setStatus("저장 중…");
    const res = v
      ? await supabase.from("free_sheet_cells").upsert(
          { tenant_id: tenantId, sheet_key: sheetKey, row_idx: r, col_idx: c, text: v, updated_at: new Date().toISOString() },
          { onConflict: "tenant_id,sheet_key,row_idx,col_idx" })
      : await supabase.from("free_sheet_cells").delete()
          .eq("tenant_id", tenantId).eq("sheet_key", sheetKey).eq("row_idx", r).eq("col_idx", c);
    setStatus(res.error ? `저장 실패: ${res.error.message}` : "저장됨");
    // 마지막 줄 근처에 쓰면 자동으로 줄 늘림
    if (v && r >= rows - 2) setRows(rows + 5);
  }

  function nav(e: KeyboardEvent<HTMLInputElement>, r: number, c: number) {
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    let nr = r, nc = c;
    if (e.key === "Enter" || e.key === "ArrowDown") nr = r + 1;
    else if (e.key === "ArrowUp") nr = r - 1;
    else if (e.key === "ArrowLeft" && e.currentTarget.selectionStart === 0) nc = c - 1;
    else if (e.key === "ArrowRight" && e.currentTarget.selectionEnd === e.currentTarget.value.length) nc = c + 1;
    else return;
    if (nr < 0 || nc < 0 || nc >= cols) return;
    e.preventDefault();
    if (nr >= rows) setRows(nr + 1);
    setTimeout(() => ref.current?.querySelector<HTMLInputElement>(`[data-fs="${nr}:${nc}"]`)?.focus(), 0);
  }

  if (!loaded) return <div className="text-xs text-gray-400">메모 불러오는 중…</div>;

  return (
    <div>
      <div className="flex items-center gap-3 mb-2">
        <h2 className="text-sm font-semibold text-black">{title}</h2>
        <span className="text-xs text-gray-400">엑셀처럼 아무 칸에나 자유롭게 · 방향키/Enter 이동 · 비우면 삭제</span>
        <span className="ml-auto text-xs text-gray-400">{status}</span>
      </div>
      <div ref={ref} className="overflow-x-auto border-l border-t border-gray-200">
        <table className="border-collapse text-xs">
          <thead>
            <tr>
              <th className="w-8 h-6 bg-gray-50 border-b border-r border-gray-200" />
              {Array.from({ length: cols }).map((_, c) => (
                <th key={c} className="min-w-[10rem] h-6 bg-gray-50 border-b border-r border-gray-200 font-normal text-gray-400">{colName(c)}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {Array.from({ length: rows }).map((_, r) => (
              <tr key={r}>
                <td className="w-8 h-8 bg-gray-50 border-b border-r border-gray-200 text-center text-gray-400">{r + 1}</td>
                {Array.from({ length: cols }).map((_, c) => (
                  <td key={c} className="h-8 p-0 border-b border-r border-gray-200">
                    <input
                      data-fs={`${r}:${c}`}
                      defaultValue={cells[key(r, c)] ?? ""}
                      onBlur={e => commit(r, c, e.currentTarget.value)}
                      onKeyDown={e => nav(e, r, c)}
                      className="w-full h-8 px-2 bg-transparent text-black focus:outline-none focus:ring-1 focus:ring-black focus:ring-inset focus:bg-white"
                    />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="flex gap-2 mt-2">
        <button type="button" onClick={() => setRows(rows + 5)} className="px-2 py-0.5 text-xs border border-gray-300 rounded hover:bg-gray-50">+ 줄 5개</button>
        <button type="button" onClick={() => setCols(cols + 1)} className="px-2 py-0.5 text-xs border border-gray-300 rounded hover:bg-gray-50">+ 열</button>
      </div>
    </div>
  );
}
