"use client";

// 장기과제 — 날짜 미정 할일 목록. 업무루틴 페이지 좌측 여백에 배치(마이그 232).
// 나중에 날짜가 정해지면 일정(ScheduleCalendar)으로 옮겨 적는 전 단계 메모함.
import { useCallback, useEffect, useState } from "react";
import { styles } from "@/common/styles";
import {
  loadLongTermTasks, addLongTermTask, toggleLongTermTask, updateLongTermTask, deleteLongTermTask,
  type LongTermTask,
} from "@/lib/longTermTasks";

export default function LongTermTasksPanel({ tenantId }: { tenantId: string }) {
  const [tasks, setTasks] = useState<LongTermTask[]>([]);
  const [title, setTitle] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState("");

  const reload = useCallback(async () => {
    setTasks(await loadLongTermTasks(tenantId));
  }, [tenantId]);
  useEffect(() => { reload(); }, [reload]);

  async function add() {
    if (!title.trim()) return;
    setTitle("");
    await addLongTermTask(tenantId, title);
    reload();
  }

  async function toggle(t: LongTermTask) {
    setTasks((prev) => prev.map((x) => (x.id === t.id ? { ...x, is_done: !x.is_done } : x))); // optimistic
    await toggleLongTermTask(t.id, !t.is_done);
  }

  function startEdit(t: LongTermTask) { setEditingId(t.id); setEditTitle(t.title); }
  function cancelEdit() { setEditingId(null); }
  async function saveEdit() {
    if (!editingId || !editTitle.trim()) return;
    const id = editingId;
    setTasks((prev) => prev.map((x) => (x.id === id ? { ...x, title: editTitle.trim() } : x))); // optimistic
    setEditingId(null);
    await updateLongTermTask(id, editTitle);
  }

  async function remove(id: string) {
    setTasks((prev) => prev.filter((x) => x.id !== id)); // optimistic
    await deleteLongTermTask(id);
  }

  const pending = tasks.filter((t) => !t.is_done);
  const done = tasks.filter((t) => t.is_done);

  return (
    <div className="bg-white border border-gray-200 rounded-xl p-3">
      <div className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">장기과제</div>
      <div className="mb-3 flex gap-1">
        <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="할일 추가"
          onKeyDown={(e) => { if (e.key === "Enter") add(); }} className={`${styles.inputMd} px-2 py-1.5 text-xs`} />
        <button onClick={add} className={`${styles.btnSmall} shrink-0`}>추가</button>
      </div>

      {tasks.length === 0 ? (
        <div className="text-xs text-gray-400 py-4 text-center">등록된 장기과제 없음</div>
      ) : (
        <ul className="space-y-1">
          {[...pending, ...done].map((t) => editingId === t.id ? (
            <li key={t.id} className="flex flex-col gap-1.5 px-2 py-1.5 bg-gray-50 rounded text-xs">
              <input value={editTitle} onChange={(e) => setEditTitle(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") saveEdit(); }} autoFocus
                className={`${styles.inputMd} px-2 py-1 text-xs`} />
              <div className="flex items-center gap-2 justify-end">
                <button onClick={cancelEdit} className="text-gray-400 hover:text-black">취소</button>
                <button onClick={saveEdit} className={styles.btnSmall}>저장</button>
              </div>
            </li>
          ) : (
            <li key={t.id} className="group flex items-start gap-1.5 px-2 py-1.5 bg-gray-50 rounded text-xs">
              <button onClick={() => toggle(t)} title={t.is_done ? "완료 취소" : "완료"}
                className={"mt-[1px] w-3.5 h-3.5 shrink-0 rounded-full border flex items-center justify-center " +
                  (t.is_done ? "bg-black border-black text-white" : "border-gray-300 hover:border-black")}>
                {t.is_done && <span className="text-[9px] leading-none">✓</span>}
              </button>
              <span className={"flex-1 break-words " + (t.is_done ? "text-gray-400 line-through" : "text-black")}>
                {t.title}
              </span>
              <span className="hidden group-hover:flex items-center gap-1.5 shrink-0">
                <button onClick={() => startEdit(t)} className="text-gray-300 hover:text-black">수정</button>
                <button onClick={() => remove(t.id)} className="text-gray-300 hover:text-rose-500">삭제</button>
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
