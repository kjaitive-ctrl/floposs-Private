"use client";

// 일정(다이어리) — 월 캘린더(자체 그리드) + 날짜별 이벤트 추가/삭제.
// 마이그 208(단발) + 213(기간). 기간 일정은 한 row(event_date~end_date)로 등록되고
// 달력에서 이어진 띠(band)로 표시됨. 하루에 여러 일정이 겹치면 주(week) 단위로
// 레인(lane)을 배정해 여러 줄로 쌓아서 보여줌(구글캘린더 월간뷰 방식).
import { useCallback, useEffect, useState } from "react";
import { styles } from "@/common/styles";
import { isoDate, loadEvents, addEvent, deleteEvent, type ScheduleEvent } from "@/lib/routines";

const CAL_DOW = ["일", "월", "화", "수", "목", "금", "토"];
const CHIP_COLORS = [
  "bg-sky-100 text-sky-800",
  "bg-amber-100 text-amber-800",
  "bg-emerald-100 text-emerald-800",
  "bg-violet-100 text-violet-800",
  "bg-rose-100 text-rose-800",
  "bg-lime-100 text-lime-800",
  "bg-cyan-100 text-cyan-800",
  "bg-fuchsia-100 text-fuchsia-800",
];
function chipColor(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return CHIP_COLORS[h % CHIP_COLORS.length];
}

function fmtMD(iso: string): string {
  const [, mo, da] = iso.split("-");
  return `${Number(mo)}/${Number(da)}`;
}

type DaySlot = { d: number; iso: string } | null;
type Seg = { e: ScheduleEvent; isStart: boolean; isEnd: boolean };
type WeekCol = { d: number; iso: string; lanes: (Seg | null)[] } | null;

// 한 주(7일)를 받아 겹치는 일정에 레인(0,1,2..)을 배정. 같은 일정은 그 주 안에서 항상 같은
// 레인에 놓여 이어진 줄로 보임(주 경계에서는 새로 배정 — 자연스러운 줄바꿈).
function layoutWeek(week: DaySlot[], events: ScheduleEvent[]): { maxLanes: number; cols: WeekCol[] } {
  const realDays = week.filter((c): c is { d: number; iso: string } => c !== null);
  if (realDays.length === 0) return { maxLanes: 0, cols: week.map(() => null) };
  const firstIso = realDays[0].iso;
  const lastIso = realDays[realDays.length - 1].iso;
  const weekEvents = events.filter((e) => e.event_date <= lastIso && e.end_date >= firstIso);
  const clipped = weekEvents
    .map((e) => ({
      e,
      cs: e.event_date > firstIso ? e.event_date : firstIso,
      ce: e.end_date < lastIso ? e.end_date : lastIso,
    }))
    .sort((a, b) => a.cs.localeCompare(b.cs) || b.ce.localeCompare(a.ce) || a.e.id.localeCompare(b.e.id));

  const laneEnds: string[] = [];
  const placed: { e: ScheduleEvent; cs: string; ce: string; lane: number }[] = [];
  for (const item of clipped) {
    let lane = laneEnds.findIndex((end) => end < item.cs);
    if (lane === -1) { lane = laneEnds.length; laneEnds.push(item.ce); }
    else laneEnds[lane] = item.ce;
    placed.push({ ...item, lane });
  }
  const maxLanes = laneEnds.length;

  const cols = week.map((slot) => {
    if (!slot) return null;
    const lanes: (Seg | null)[] = Array(maxLanes).fill(null);
    for (const p of placed) {
      if (slot.iso >= p.cs && slot.iso <= p.ce) {
        lanes[p.lane] = { e: p.e, isStart: slot.iso === p.cs, isEnd: slot.iso === p.ce };
      }
    }
    return { d: slot.d, iso: slot.iso, lanes };
  });
  return { maxLanes, cols };
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

  // 그 날짜와 "겹치는" 모든 일정(기간 일정은 진행 중인 모든 날에 잡힘) — 선택일 패널용
  const daysInMonth = new Date(y, m + 1, 0).getDate();
  const byDate = new Map<string, ScheduleEvent[]>();
  for (let d = 1; d <= daysInMonth; d++) {
    const iso = isoDate(new Date(y, m, d));
    const list = events.filter((e) => e.event_date <= iso && e.end_date >= iso);
    if (list.length) byDate.set(iso, list);
  }

  const startDow = new Date(y, m, 1).getDay();
  const slots: DaySlot[] = [];
  for (let i = 0; i < startDow; i++) slots.push(null);
  for (let d = 1; d <= daysInMonth; d++) slots.push({ d, iso: isoDate(new Date(y, m, d)) });
  while (slots.length % 7 !== 0) slots.push(null);
  const weeks: DaySlot[][] = [];
  for (let i = 0; i < slots.length; i += 7) weeks.push(slots.slice(i, i + 7));

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
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
      {/* 캘린더 */}
      <div className="lg:col-span-2 bg-white border border-gray-200 rounded-xl p-4">
        <div className="flex items-center justify-between mb-3">
          <button onClick={prevMonth} className="text-gray-400 hover:text-black text-2xl px-3 py-1 leading-none">‹</button>
          <span className="text-lg font-bold text-black">{y}년 {m + 1}월</span>
          <button onClick={nextMonth} className="text-gray-400 hover:text-black text-2xl px-3 py-1 leading-none">›</button>
        </div>
        <div className="grid grid-cols-7 text-center text-xs text-gray-400 mb-1 border-b border-gray-100 pb-1">
          {CAL_DOW.map((d, i) => <div key={d} className={i === 0 ? "text-rose-400" : i === 6 ? "text-blue-400" : ""}>{d}</div>)}
        </div>
        <div className="divide-y divide-gray-100">
          {weeks.map((week, wi) => {
            const { cols } = layoutWeek(week, events);
            return (
              <div key={wi} className="grid grid-cols-7 divide-x divide-gray-100">
                {cols.map((col, ci) => {
                  if (!col) return <div key={ci} className="min-h-[110px]" />;
                  const { d, iso, lanes } = col;
                  const isSel = iso === selected;
                  const isToday = iso === todayIso;
                  return (
                    <div key={ci} className={`min-h-[110px] flex flex-col ${isSel ? "bg-gray-50" : ""}`}>
                      <button onClick={() => selectDay(iso)}
                        className={"m-1 self-start w-6 h-6 shrink-0 flex items-center justify-center rounded-full text-xs " +
                          (isToday ? "bg-black text-white font-bold" : isSel ? "border border-black text-black font-bold" : "text-gray-600 hover:bg-gray-100")}>
                        {d}
                      </button>
                      <div className="flex flex-col gap-[2px] pb-1">
                        {lanes.map((seg, li) => {
                          if (!seg) return <div key={li} className="h-[16px]" />;
                          const round = (seg.isStart ? "rounded-l " : "") + (seg.isEnd ? "rounded-r" : "");
                          return (
                            <div key={li} title={seg.e.title}
                              className={`h-[16px] leading-[16px] text-[10px] px-1 truncate ${chipColor(seg.e.id)} ${round}`}>
                              {seg.isStart ? seg.e.title : " "}
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>
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
                <span className={`inline-block w-2 h-2 rounded-full shrink-0 ${chipColor(e.id).split(" ")[0]}`} />
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
