"use client";

// 일정(다이어리) — 간단 월 캘린더(자체 그리드) + 날짜별 이벤트 추가/삭제. 마이그 208.
import { useCallback, useEffect, useState } from "react";
import { styles } from "@/common/styles";
import { isoDate, loadEvents, addEvent, deleteEvent, type ScheduleEvent } from "@/lib/routines";

const CAL_DOW = ["일", "월", "화", "수", "목", "금", "토"];

export default function ScheduleCalendar({ tenantId }: { tenantId: string }) {
  const today = new Date();
  const [y, setY] = useState(today.getFullYear());
  const [m, setM] = useState(today.getMonth()); // 0~11
  const [events, setEvents] = useState<ScheduleEvent[]>([]);
  const [selected, setSelected] = useState<string>(isoDate(today));
  const [title, setTitle] = useState("");
  const [assignee, setAssignee] = useState("");

  const monthStart = isoDate(new Date(y, m, 1));
  const monthEnd = isoDate(new Date(y, m + 1, 0));

  const reload = useCallback(async () => {
    setEvents(await loadEvents(tenantId, monthStart, monthEnd));
  }, [tenantId, monthStart, monthEnd]);
  useEffect(() => { reload(); }, [reload]);

  const byDate = new Map<string, ScheduleEvent[]>();
  for (const e of events) {
    const a = byDate.get(e.event_date) ?? [];
    a.push(e); byDate.set(e.event_date, a);
  }

  const startDow = new Date(y, m, 1).getDay();
  const daysInMonth = new Date(y, m + 1, 0).getDate();
  const cells: (number | null)[] = [];
  for (let i = 0; i < startDow; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(d);

  const todayIso = isoDate(today);
  const selEvents = byDate.get(selected) ?? [];

  function prevMonth() { if (m === 0) { setY(y - 1); setM(11); } else setM(m - 1); }
  function nextMonth() { if (m === 11) { setY(y + 1); setM(0); } else setM(m + 1); }

  async function add() {
    if (!title.trim()) return;
    await addEvent(tenantId, selected, title, assignee || null, null);
    setTitle(""); setAssignee("");
    reload();
  }
  async function remove(id: string) { await deleteEvent(id); reload(); }

  return (
    <div className="grid md:grid-cols-2 gap-4">
      {/* 캘린더 */}
      <div className="bg-white border border-gray-200 rounded-xl p-3">
        <div className="flex items-center justify-between mb-2">
          <button onClick={prevMonth} className="text-gray-400 hover:text-black px-2">‹</button>
          <span className="text-sm font-bold text-black">{y}년 {m + 1}월</span>
          <button onClick={nextMonth} className="text-gray-400 hover:text-black px-2">›</button>
        </div>
        <div className="grid grid-cols-7 text-center text-[11px] text-gray-400 mb-1">
          {CAL_DOW.map((d, i) => <div key={d} className={i === 0 ? "text-rose-400" : i === 6 ? "text-blue-400" : ""}>{d}</div>)}
        </div>
        <div className="grid grid-cols-7 gap-0.5">
          {cells.map((d, i) => {
            if (d == null) return <div key={i} />;
            const iso = isoDate(new Date(y, m, d));
            const cnt = byDate.get(iso)?.length ?? 0;
            const isSel = iso === selected;
            const isToday = iso === todayIso;
            return (
              <button key={i} onClick={() => setSelected(iso)}
                className={"aspect-square rounded text-xs flex flex-col items-center justify-center border " +
                  (isSel ? "border-black bg-gray-50" : "border-transparent hover:bg-gray-50") +
                  (isToday ? " font-bold text-black" : " text-gray-600")}>
                <span>{d}</span>
                {cnt > 0 && <span className="w-1 h-1 rounded-full bg-emerald-500 mt-0.5" />}
              </button>
            );
          })}
        </div>
      </div>

      {/* 선택일 이벤트 */}
      <div className="bg-white border border-gray-200 rounded-xl p-3">
        <div className="text-sm font-bold text-black mb-2">{selected} 일정</div>
        <div className="flex gap-1.5 mb-2">
          <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="일정 추가"
            onKeyDown={(e) => { if (e.key === "Enter") add(); }} className={`${styles.inputMd} flex-1 min-w-0`} />
          <input value={assignee} onChange={(e) => setAssignee(e.target.value)} placeholder="담당" className={`${styles.inputMd} w-20 shrink-0`} />
          <button onClick={add} className={`${styles.btnPrimary} shrink-0`}>추가</button>
        </div>
        {selEvents.length === 0 ? (
          <div className="text-xs text-gray-400 py-4 text-center">일정 없음</div>
        ) : (
          <ul className="space-y-1">
            {selEvents.map((e) => (
              <li key={e.id} className="flex items-center gap-2 px-2 py-1.5 bg-gray-50 rounded text-sm">
                <span className="text-black flex-1">{e.title}{e.assignee && <span className="text-gray-400 text-xs"> · {e.assignee}</span>}</span>
                <button onClick={() => remove(e.id)} className="text-xs text-gray-300 hover:text-rose-500">삭제</button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
