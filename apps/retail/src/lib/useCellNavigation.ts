import { useCallback, type KeyboardEvent, type MutableRefObject } from "react";

// 인라인 표 키보드 네비 hook.
// /samples + /products 의 handleNav 동일 로직 추출 (2026-05-26).
//
// 동작:
//   ↑ / Shift+Enter = 위 row 의 같은 column 으로 focus
//   ↓ / Enter       = 아래 row 의 같은 column 으로 focus
//   그 외 키        = 통과 (event 안 막음)
//
// fallbackCol = 같은 column id 없을 때 (예: samples 의 draft 행은 wholesale_name 만 있음)
//               대체 column 반환. null 반환 시 nothing-happens (focus 그대로).

interface NavRow { _key: string }

interface Options<R extends NavRow> {
  rowsRef: MutableRefObject<R[]>;
  /** 같은 column 의 cell id 없을 때 대체 column 반환. null = 통과 */
  fallbackCol?: (nextRow: R, currentCol: string) => string | null;
  /** cell id prefix. default "cell" → "cell-{rowKey}-{col}" */
  cellIdPrefix?: string;
}

export function useCellNavigation<R extends NavRow>({ rowsRef, fallbackCol, cellIdPrefix = "cell" }: Options<R>) {
  return useCallback(
    (e: KeyboardEvent<HTMLInputElement | HTMLSelectElement>, rowKey: string, col: string) => {
      const isUp   = e.key === "ArrowUp"   || (e.key === "Enter" && e.shiftKey);
      const isDown = e.key === "ArrowDown" || (e.key === "Enter" && !e.shiftKey);
      if (!isUp && !isDown) return;
      e.preventDefault();
      const idx = rowsRef.current.findIndex(r => r._key === rowKey);
      if (idx < 0) return;
      const nextIdx = isUp ? idx - 1 : idx + 1;
      if (nextIdx < 0 || nextIdx >= rowsRef.current.length) return;
      const nextRow = rowsRef.current[nextIdx];
      const nextKey = nextRow._key;
      const sameCol = document.getElementById(`${cellIdPrefix}-${nextKey}-${col}`);
      if (sameCol) { sameCol.focus(); return; }
      if (fallbackCol) {
        const fb = fallbackCol(nextRow, col);
        if (fb) document.getElementById(`${cellIdPrefix}-${nextKey}-${fb}`)?.focus();
      }
    },
    [rowsRef, fallbackCol, cellIdPrefix]
  );
}
