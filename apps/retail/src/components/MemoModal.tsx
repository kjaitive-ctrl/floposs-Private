"use client";

import { useState, useEffect, useRef } from "react";
import { styles } from "@/common/styles";

// 메모 편집 모달 — 줄바꿈 가능한 textarea + 자동저장 debounce.
// /samples 의 description, /products 의 progress_memo + description 양쪽 공유.
//
// 사용:
//   <MemoModal
//     title="메모(진행)"
//     initialValue={row.progress_memo}
//     onSave={async (val) => { await supabase.from("products").update({ progress_memo: val }).eq("id", row.id); }}
//     onClose={() => setMemoModal(null)}
//     readOnly={false}
//   />

const SAVE_DEBOUNCE = 700;
const SAVE_FLASH = 1000;

type SaveStatus = "idle" | "saving" | "saved" | "error";

interface Props {
  title: string;
  initialValue: string;
  onSave: (value: string) => Promise<void>;
  onClose: () => void;
  readOnly?: boolean;
}

export default function MemoModal({ title, initialValue, onSave, onClose, readOnly }: Props) {
  const [value, setValue] = useState(initialValue);
  const [saveStatus, setSaveStatus] = useState<SaveStatus>("idle");
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inFlight = useRef(false);
  const dirtyAgain = useRef(false);
  const valueRef = useRef(value);
  valueRef.current = value;

  function scheduleSave() {
    if (readOnly) return;
    if (inFlight.current) { dirtyAgain.current = true; return; }
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => doSave(), SAVE_DEBOUNCE);
  }

  async function doSave() {
    if (readOnly || inFlight.current) return;
    inFlight.current = true;
    setSaveStatus("saving");
    try {
      await onSave(valueRef.current);
      setSaveStatus("saved");
      setTimeout(() => setSaveStatus(s => s === "saved" ? "idle" : s), SAVE_FLASH);
    } catch (e) {
      setSaveStatus("error");
      console.error("MemoModal save error:", e);
    } finally {
      inFlight.current = false;
      if (dirtyAgain.current) {
        dirtyAgain.current = false;
        setTimeout(() => doSave(), 50);
      }
    }
  }

  function handleClose() {
    // 닫을 때 pending save flush
    if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null; }
    if (!readOnly && valueRef.current !== initialValue && !inFlight.current) {
      doSave();
    }
    onClose();
  }

  // ESC 닫기
  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") handleClose();
    }
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const dotBase = "inline-block w-2.5 h-2.5 rounded-full";
  const dot =
    saveStatus === "saving" ? <span className={`${dotBase} bg-gray-400 animate-pulse`} title="저장 중" /> :
    saveStatus === "saved"  ? <span className={`${dotBase} bg-green-500`} title="저장됨" /> :
    saveStatus === "error"  ? <span className={`${dotBase} bg-red-500`} title="저장 실패" /> :
                              <span className={`${dotBase} bg-transparent`} />;

  return (
    <div className={styles.modalOverlay} onClick={handleClose}>
      <div className="w-full max-w-lg bg-white rounded shadow-lg p-4 mx-4"
        onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <h3 className="text-sm font-medium text-black">{title}</h3>
            {dot}
            {readOnly && <span className="text-xs text-gray-500">(읽기 전용)</span>}
          </div>
          <button onClick={handleClose} title="닫기 (Esc)"
            className="text-gray-400 hover:text-black text-lg leading-none">×</button>
        </div>
        <textarea
          autoFocus
          value={value}
          onChange={e => { if (readOnly) return; setValue(e.target.value); scheduleSave(); }}
          readOnly={readOnly}
          rows={8}
          placeholder={readOnly ? "" : "메모 (Enter 줄바꿈)"}
          className={`${styles.inputMd} resize-none`}
        />
        <div className="mt-2 flex justify-end">
          <button onClick={handleClose} className={styles.btnSmallGhost}>
            닫기
          </button>
        </div>
      </div>
    </div>
  );
}
