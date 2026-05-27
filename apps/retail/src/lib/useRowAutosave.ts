import { useCallback, useEffect, useRef, useState } from "react";
import type { SaveStatus } from "@/lib/samplesUtils";

// 인라인 표 행 자동저장 hook.
// /samples + /products 의 timers/inFlight/dirtyAgain + setSaveStatus + debounce 동일 로직 추출 (2026-05-26).
//
// 사용 패턴:
//   const { saveState, setSaveStatus, scheduleAutosave, runSave } = useRowAutosave({
//     saveRow: async (rowKey) => {
//       // 실 DB 저장 로직 (closure 로 rowsRef/tenant 등 참조)
//       const row = rowsRef.current.find(r => r._key === rowKey);
//       if (!row?.id) return { ok: true };  // skip 시에도 ok 반환 가능
//       const { error } = await supabase.from("...").update({...});
//       return { ok: !error };
//     }
//   });
//
//   function updateCell(rowKey, field, value) {
//     setRows(prev => ...);
//     scheduleAutosave(rowKey);  // debounce 자동저장 트리거
//   }
//
//   // 즉시 저장 (Enter 등): await runSave(rowKey)
//
// 보존하는 미묘 로직:
//   - inFlight 중 추가 수정 → dirtyAgain 으로 마킹 → 저장 완료 후 50ms 재호출
//   - 같은 rowKey 에 대한 동시 호출 차단 (inFlight Set)
//   - debounce 타이머 갱신 시 기존 타이머 clearTimeout

const DEFAULT_DEBOUNCE_MS = 700;
const DEFAULT_FLASH_MS = 1000;

interface SaveResult { ok: boolean }

interface Options {
  saveRow: (rowKey: string) => Promise<SaveResult>;
  debounceMs?: number;
  flashMs?: number;
}

export function useRowAutosave({ saveRow, debounceMs = DEFAULT_DEBOUNCE_MS, flashMs = DEFAULT_FLASH_MS }: Options) {
  const [saveState, setSaveState] = useState<Record<string, SaveStatus>>({});
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const inFlight = useRef(new Set<string>());
  const dirtyAgain = useRef(new Set<string>());

  // saveRow callback 의 최신 버전을 ref 로 박음 — useEffect/setTimeout closure 안에서도 최신 closure 참조
  const saveRowRef = useRef(saveRow);
  useEffect(() => { saveRowRef.current = saveRow; });

  const setSaveStatus = useCallback((rowKey: string, status: SaveStatus, autoClear = false) => {
    setSaveState(s => ({ ...s, [rowKey]: status }));
    if (autoClear) {
      setTimeout(() => setSaveState(s => {
        if (s[rowKey] !== status) return s;
        const next = { ...s };
        delete next[rowKey];
        return next;
      }), flashMs);
    }
  }, [flashMs]);

  const runSave = useCallback(async (rowKey: string) => {
    if (inFlight.current.has(rowKey)) return;
    inFlight.current.add(rowKey);
    setSaveStatus(rowKey, "saving");
    let ok = false;
    try {
      const res = await saveRowRef.current(rowKey);
      ok = res.ok;
    } catch (e) {
      console.error("useRowAutosave saveRow threw:", e);
    }
    inFlight.current.delete(rowKey);
    if (!ok) {
      setSaveStatus(rowKey, "error");
      return;
    }
    setSaveStatus(rowKey, "saved", true);

    if (dirtyAgain.current.has(rowKey)) {
      dirtyAgain.current.delete(rowKey);
      const t = setTimeout(() => runSave(rowKey), 50);
      timers.current.set(rowKey, t);
    }
  }, [setSaveStatus]);

  const scheduleAutosave = useCallback((rowKey: string) => {
    if (inFlight.current.has(rowKey)) {
      dirtyAgain.current.add(rowKey);
      return;
    }
    const existing = timers.current.get(rowKey);
    if (existing) clearTimeout(existing);
    const t = setTimeout(() => runSave(rowKey), debounceMs);
    timers.current.set(rowKey, t);
  }, [debounceMs, runSave]);

  return { saveState, setSaveStatus, scheduleAutosave, runSave };
}
