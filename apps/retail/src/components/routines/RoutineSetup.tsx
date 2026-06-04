"use client";

// 업무루틴 세팅 (2주 사이클). 할일 추가 + 반복일(1주차 월~일 / 2주차 월~일) 토글 + 삭제.
import { useCallback, useEffect, useState } from "react";
import { styles } from "@/common/styles";
import {
  DOW, loadRoutines, addRoutine, updateRoutine, deleteRoutine, type Routine,
} from "@/lib/routines";

function Chips({ days, onToggle }: { days: number[]; onToggle: (cd: number) => void }) {
  return (
    <div className="flex flex-col gap-1">
      {[1, 2].map((week) => (
        <div key={week} className="flex items-center gap-1">
          <span className="text-[10px] text-gray-400 w-7 shrink-0">{week}주</span>
          {DOW.map((label, i) => {
            const cd = (week - 1) * 7 + i + 1;
            const on = days.includes(cd);
            const sun = i === 6, sat = i === 5;
            return (
              <button key={cd} type="button" onClick={() => onToggle(cd)}
                className={"w-6 h-6 rounded text-[11px] border " +
                  (on ? "bg-black text-white border-black"
                      : `bg-white border-gray-200 hover:bg-gray-50 ${sun ? "text-rose-400" : sat ? "text-blue-400" : "text-gray-500"}`)}>
                {label}
              </button>
            );
          })}
        </div>
      ))}
    </div>
  );
}

export default function RoutineSetup({ tenantId }: { tenantId: string }) {
  const [routines, setRoutines] = useState<Routine[]>([]);
  const [loading, setLoading] = useState(true);
  const [title, setTitle] = useState("");
  const [assignee, setAssignee] = useState("");
  const [days, setDays] = useState<number[]>([]);

  const reload = useCallback(async () => {
    setRoutines(await loadRoutines(tenantId));
    setLoading(false);
  }, [tenantId]);
  useEffect(() => { reload(); }, [reload]);

  const toggleNew = (cd: number) => setDays((d) => (d.includes(cd) ? d.filter((x) => x !== cd) : [...d, cd].sort((a, b) => a - b)));

  async function add() {
    if (!title.trim()) { alert("할일 제목을 입력하세요."); return; }
    if (days.length === 0) { alert("반복할 요일을 1개 이상 선택하세요."); return; }
    await addRoutine(tenantId, title, assignee || null, days);
    setTitle(""); setAssignee(""); setDays([]);
    reload();
  }

  async function toggleExisting(r: Routine, cd: number) {
    const next = r.cycle_days.includes(cd) ? r.cycle_days.filter((x) => x !== cd) : [...r.cycle_days, cd].sort((a, b) => a - b);
    setRoutines((prev) => prev.map((x) => (x.id === r.id ? { ...x, cycle_days: next } : x))); // optimistic
    await updateRoutine(r.id, { cycle_days: next });
  }

  async function remove(r: Routine) {
    if (!confirm(`"${r.title}" 루틴을 삭제할까요?`)) return;
    setRoutines((prev) => prev.filter((x) => x.id !== r.id));
    await deleteRoutine(r.id);
  }

  return (
    <div>
      {/* 추가 폼 */}
      <div className="bg-emerald-50 border border-emerald-200 rounded-xl px-4 py-3 mb-4">
        <div className="text-xs font-semibold text-emerald-800 mb-2">+ 업무루틴 추가</div>
        <div className="flex flex-wrap gap-2 items-start">
          <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="할일 (예: 신상 발주)"
            className={`${styles.inputMd} bg-white flex-1 min-w-[160px]`} />
          <input value={assignee} onChange={(e) => setAssignee(e.target.value)} placeholder="담당(선택)"
            className={`${styles.inputMd} bg-white w-28`} />
          <Chips days={days} onToggle={toggleNew} />
          <button type="button" onClick={add} className={styles.btnPrimary}>추가</button>
        </div>
      </div>

      {/* 목록 */}
      {loading ? (
        <div className="text-xs text-gray-400">불러오는 중…</div>
      ) : routines.length === 0 ? (
        <div className="text-sm text-gray-400 text-center py-8">등록된 업무루틴이 없습니다.</div>
      ) : (
        <ul className="space-y-2">
          {routines.map((r) => (
            <li key={r.id} className="bg-white border border-gray-200 rounded-xl px-4 py-3 flex flex-wrap items-center gap-3">
              <div className="min-w-[160px] flex-1">
                <div className="font-medium text-black">{r.title}</div>
                {r.assignee && <div className="text-[11px] text-gray-400">담당 · {r.assignee}</div>}
              </div>
              <Chips days={r.cycle_days} onToggle={(cd) => toggleExisting(r, cd)} />
              <button type="button" onClick={() => remove(r)} className="text-xs text-gray-400 hover:text-rose-500">삭제</button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
