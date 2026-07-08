"use client";

// 일정(다이어리) — 간단 월 캘린더(자체 그리드) + 날짜별 이벤트 추가/삭제.
// 마이그 208(단발) + 213(기간). 기간 일정은 한 row(event_date~end_date)로 등록되고
// 달력에서 이어진 띠(band)로 표시됨.
import { useCallback, useEffect, useState } from "react";
import { styles } from "@/common/styles";
import { isoDate, loadEvents, addEvent, deleteEvent, type ScheduleEvent } from "@/lib/routines";

const CAL_DOW = ["일", "월", "화", "수", "목", "금", "토"];

function fmtMD(iso: string): string {
  const [, mo, da] = iso.split("-");
  return `${Number(mo)}/${Number(da)}`;
}

export default function ScheduleCalendar({ tenantId }: { tenantId: string }) {
  const today = new Date();
  const [y, setY] = useState(today.getFullYear());
  const [m, setM] = useState(today.getMonth()); // 0~11
  const [events, setEvents] = useState<ScheduleEvent[]>([]);
  const [selected, setSelected] = useState<string>(isoDate(today));
  const [title, setTitle] = useState("");
  const [assignee, setAssignee] = useState("");
  const [endDate, setEndDate] = useState<string>(isoDate(today));

  const monthStart = isoDate(new Date(y, m, 1));
  const monthEnd = isoDate(new Date(y, m + 1, 0));

  const reload = useCallback(async () => {
    setEvents(await loadEvents(tenantId, monthStart, monthEnd));
  }, [tenantId, monthStart, monthEnd]);
  useEffect(() => { reload(); }, [reload]);

  // 그 날짜와 "겹치는" 모든 일정(기간 일정은 진행 중인 모든 날에 잡힘)
  const byDate = new Map<string, ScheduleEvent[]>();
  const daysInMonth0 = new Date(y, m + 1, 0).getDate();
  for (let d = 1; d <= daysInMonth0; d++) {
    const iso = isoDate(new Date(y, m, d));
    const list = events.filter((e) => e.event_date <= iso && e.end_date >= iso);
    if (list.length) byDate.set(iso, list);
  }
  // 기간(2일+) 일정만 — 같은 날 여러 개면 시작일이 빠른 순으로 대표 1개만 띠로 표시
  function rangeEventForDay(iso: string): ScheduleEvent | null {
    const candidates = events
      .filter((e) => e.event_date !== e.end_date && e.event_date <= iso && e.end_date >= iso)
      .sort((a, b) => a.event_date.localeCompare(b.event_date) || a.id.localeCompare(b.id));
    return candidates[0] ?? null;
  }

  const startDow = new Date(y, m, 1).getDay();
  const daysInMonth = daysInMonth0;
  const cells: (number | null)[] = [];
  for (let i = 0; i < startDow; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(d);

  const todayIso = isoDate(today);
  const selEvents = byDate.get(selected) ?? [];

  function prevMonth() { if (m === 0) { setY(y - 1); setM(11); } else setM(m - 1); }
  function nextMonth() { if (m === 11) { setY(y + 1); setM(0); } else setM(m + 1); }

  function selectDay(iso: string) { setSelected(iso); setEndDate(iso); }
  function setStart(iso: string) { setSelected(iso); setEndDate(iso); }

  async function add() {
    if (!title.trim()) return;
    await addEvent(tenantId, selected, title, assignee || null, null, endDate);
    setTitle(""); setAssignee(""); setEndDate(selected);
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
        <div className="grid grid-cols-7 gap-y-0.5">
          {cells.map((d, i) => {
            if (d == null) return <div key={i} />;
            const iso = isoDate(new Date(y, m, d));
            const dow = i % 7;
            const cnt = byDate.get(iso)?.length ?? 0;
            const isSel = iso === selected;
            const isToday = iso === todayIso;
            const rangeEv = rangeEventForDay(iso);
            const isStart = !!rangeEv && (rangeEv.event_date === iso || dow === 0);
            const isEnd = !!rangeEv && (rangeEv.end_date === iso || dow === 6);
            const bandRound = !rangeEv ? "" : isStart && isEnd ? "rounded" : isStart ? "rounded-l" : isEnd ? "rounded-r" : "";
            const marginCls = `${rangeEv && !isStart ? "ml-0" : "ml-[1px]"} ${rangeEv && !isEnd ? "mr-0" : "mr-[1px]"}`;
            return (
              <div key={i} className={`relative ${marginCls}`}>
                {rangeEv && <div className={`absolute inset-0 bg-amber-100 ${bandRound}`} />}
                <button onClick={() => selectDay(iso)}
                  className={"relative z-10 aspect-square w-full rounded text-xs flex flex-col items-center justify-center border " +
                    (isSel ? "border-black bg-gray-50" : "border-transparent hover:bg-gray-50/70") +
                    (isToday ? " font-bold text-black" : " text-gray-600")}>
                  <span>{d}</span>
                  {cnt > 0 && <span className="w-1 h-1 rounded-full bg-emerald-500 mt-0.5" />}
                </button>
              </div>
            );
          })}
        </div>
        {events.some((e) => e.event_date !== e.end_date) && (
          <div className="flex items-center gap-1 mt-2 text-[11px] text-gray-400">
            <span className="inline-block w-2.5 h-2.5 rounded-sm bg-amber-100" /> 기간 일정
          </div>
        )}
      </div>

      {/* 선택일 이벤트 */}
      <div className="bg-white border border-gray-200 rounded-xl p-3">
        <div className="mb-3 space-y-1.5">
          <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="일정 추가"
            onKeyDown={(e) => { if (e.key === "Enter") add(); }} className={styles.inputMd} />
          <input value={assignee} onChange={(e) => setAssignee(e.target.value)} placeholder="담당"
            className={`${styles.inputMd} w-20 px-2`} />
          <div className="flex items-center gap-1">
            <input type="date" value={selected} onChange={(e) => setStart(e.target.value)}
              title="시작 날짜" className={`${styles.inputMd} min-w-0 px-2 flex-1`} />
            <span className="text-[11px] text-gray-400 shrink-0">~</span>
            <input type="date" value={endDate} min={selected} onChange={(e) => setEndDate(e.target.value)}
              title="종료 날짜 (여러 날짜를 한 번에 등록하려면 시작일보다 뒤로 선택)" className={`${styles.inputMd} min-w-0 px-2 flex-1`} />
          </div>
          <button onClick={add} className={`${styles.btnPrimary} w-full`}>추가</button>
        </div>
        {selEvents.length === 0 ? (
          <div className="text-xs text-gray-400 py-4 text-center">{fmtMD(selected)} 일정 없음</div>
        ) : (
          <ul className="space-y-1">
            {selEvents.map((e) => (
              <li key={e.id} className="flex items-center gap-2 px-2 py-1.5 bg-gray-50 rounded text-sm">
                <span className="text-black flex-1">
                  {e.title}
                  {e.assignee && <span className="text-gray-400 text-xs"> · {e.assignee}</span>}
                  {e.event_date !== e.end_date && (
                    <span className="text-gray-400 text-[11px]"> ({fmtMD(e.event_date)}~{fmtMD(e.end_date)})</span>
                  )}
                </span>
                <button onClick={() => remove(e.id)} className="text-xs text-gray-300 hover:text-rose-500">삭제</button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
