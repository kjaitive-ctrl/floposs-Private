"use client";

// 대시보드 위젯 모음 (모듈화). 날씨(Open-Meteo 11일) · 오늘 할일(업무루틴 2주) · 다가오는 일정.
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  isoDate, cycleDayOf, loadRoutines, loadChecks, setCheck, unsetCheck,
  loadEvents, type Routine, type ScheduleEvent,
} from "@/lib/routines";

const DOW = ["일", "월", "화", "수", "목", "금", "토"];

// ── 날씨 (Open-Meteo 11일. 상업 런칭 전 KMA 전환) ──
interface DailyWx { date: string; code: number; tmax: number; tmin: number; pop: number | null; }
function wx(c: number): string {
  if (c === 0) return "☀️"; if (c <= 2) return "🌤️"; if (c === 3) return "☁️";
  if (c === 45 || c === 48) return "🌫️"; if (c >= 51 && c <= 57) return "🌦️";
  if (c >= 61 && c <= 67) return "🌧️"; if (c >= 71 && c <= 77) return "🌨️";
  if (c >= 80 && c <= 82) return "🌧️"; if (c >= 85 && c <= 86) return "🌨️";
  if (c >= 95) return "⛈️"; return "·";
}
export function WeatherWidget() {
  const [days, setDays] = useState<DailyWx[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState(false);
  useEffect(() => {
    let c = false;
    (async () => {
      try {
        const url = "https://api.open-meteo.com/v1/forecast?latitude=37.5665&longitude=126.9780&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max&forecast_days=11&timezone=Asia%2FSeoul";
        const j = await (await fetch(url, { cache: "no-store" })).json();
        if (c) return;
        const d = j.daily;
        setDays((d?.time ?? []).map((t: string, i: number) => ({ date: t, code: d.weather_code[i], tmax: d.temperature_2m_max[i], tmin: d.temperature_2m_min[i], pop: d.precipitation_probability_max?.[i] ?? null })));
        setLoading(false);
      } catch { if (!c) { setErr(true); setLoading(false); } }
    })();
    return () => { c = true; };
  }, []);
  const today = days[0]?.date;
  return (
    <div className="bg-white border border-gray-200 rounded-2xl overflow-hidden">
      <div className="px-3 py-2 border-b border-gray-100 flex items-center gap-1.5">
        <span className="text-sm font-bold text-black">11일 날씨</span>
        <span className="text-[11px] text-gray-400">서울</span>
        <span className="ml-auto text-[10px] text-gray-300">Open-Meteo</span>
      </div>
      {loading ? <div className="text-xs text-gray-400 px-3 py-8 text-center">불러오는 중…</div>
        : err || days.length === 0 ? <div className="text-xs text-gray-400 px-3 py-8 text-center">날씨 못 불러옴</div>
        : (
          <ul className="divide-y divide-gray-50">
            {days.map((d) => {
              const dt = new Date(d.date + "T00:00:00");
              return (
                <li key={d.date} className={"flex items-center gap-2 px-3 py-1.5 text-xs" + (d.date === today ? " bg-sky-50/50" : "")}>
                  <span className="w-11 text-gray-600 whitespace-nowrap">{`${dt.getMonth() + 1}/${dt.getDate()}`}<span className="text-gray-400">({DOW[dt.getDay()]})</span></span>
                  <span className="w-5 text-center">{wx(d.code)}</span>
                  <span className="w-9 text-right text-blue-500">{d.pop != null ? `${d.pop}%` : ""}</span>
                  <span className="ml-auto whitespace-nowrap"><span className="text-blue-600">{Math.round(d.tmin)}°</span><span className="text-gray-300">/</span><span className="text-rose-600">{Math.round(d.tmax)}°</span></span>
                </li>
              );
            })}
          </ul>
        )}
    </div>
  );
}

// ── 오늘 할일 (업무루틴 2주 사이클) ──
export function TodayTasksWidget({ tenantId }: { tenantId: string }) {
  const [tasks, setTasks] = useState<Routine[]>([]);
  const [done, setDone] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const todayIso = isoDate(new Date());
  const cd = cycleDayOf(new Date());

  const reload = useCallback(async () => {
    const rs = await loadRoutines(tenantId);
    const todays = rs.filter((r) => r.cycle_days.includes(cd));
    setTasks(todays);
    setDone(await loadChecks(todays.map((t) => t.id), todayIso));
    setLoading(false);
  }, [tenantId, cd, todayIso]);
  useEffect(() => { reload(); }, [reload]);

  async function toggle(r: Routine) {
    const isDone = done.has(r.id);
    setDone((prev) => { const n = new Set(prev); if (isDone) n.delete(r.id); else n.add(r.id); return n; });
    if (isDone) await unsetCheck(r.id, todayIso);
    else await setCheck(r.id, todayIso, r.assignee);
  }

  const remaining = tasks.filter((t) => !done.has(t.id)).length;

  return (
    <div className="bg-white border border-gray-200 rounded-2xl overflow-hidden">
      <div className="px-4 py-2.5 border-b border-gray-100 flex items-center gap-2">
        <span className="text-sm font-bold text-black">오늘 할일</span>
        {!loading && <span className="text-xs text-gray-400">남은 {remaining} / {tasks.length}</span>}
        <Link href="/routines?tab=routine" className="ml-auto text-xs text-gray-500 hover:text-black border border-gray-200 rounded px-2 py-0.5">세팅</Link>
      </div>
      {loading ? <div className="text-xs text-gray-400 px-4 py-6 text-center">불러오는 중…</div>
        : tasks.length === 0 ? (
          <div className="text-xs text-gray-400 px-4 py-6 text-center">
            오늘 할일이 없어요. <Link href="/routines?tab=routine" className="text-primary hover:underline">업무루틴 세팅</Link>
          </div>
        ) : (
          <ul className="divide-y divide-gray-50">
            {tasks.map((r) => {
              const isDone = done.has(r.id);
              return (
                <li key={r.id} className="flex items-center gap-2.5 px-4 py-2">
                  <button type="button" onClick={() => toggle(r)}
                    className={"w-5 h-5 rounded-md border flex items-center justify-center shrink-0 " + (isDone ? "bg-emerald-500 border-emerald-500 text-white" : "border-gray-300 hover:border-gray-400")}>
                    {isDone && "✓"}
                  </button>
                  <span className={"text-sm flex-1 " + (isDone ? "text-gray-300 line-through" : "text-black")}>
                    {r.title}{r.assignee && <span className="text-[11px] text-gray-400"> · {r.assignee}</span>}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
    </div>
  );
}

// ── 다가오는 일정 (오늘~+14일) ──
export function UpcomingScheduleWidget({ tenantId }: { tenantId: string }) {
  const [events, setEvents] = useState<ScheduleEvent[]>([]);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let c = false;
    (async () => {
      const today = new Date();
      const to = new Date(today); to.setDate(to.getDate() + 14);
      const ev = await loadEvents(tenantId, isoDate(today), isoDate(to));
      if (!c) { setEvents(ev); setLoading(false); }
    })();
    return () => { c = true; };
  }, [tenantId]);

  return (
    <div className="bg-white border border-gray-200 rounded-2xl overflow-hidden">
      <div className="px-4 py-2.5 border-b border-gray-100 flex items-center gap-2">
        <span className="text-sm font-bold text-black">다가오는 일정</span>
        <span className="text-xs text-gray-400">2주</span>
        <Link href="/routines?tab=schedule" className="ml-auto text-xs text-gray-500 hover:text-black border border-gray-200 rounded px-2 py-0.5">달력</Link>
      </div>
      {loading ? <div className="text-xs text-gray-400 px-4 py-6 text-center">불러오는 중…</div>
        : events.length === 0 ? <div className="text-xs text-gray-400 px-4 py-6 text-center">예정된 일정이 없어요.</div>
        : (
          <ul className="divide-y divide-gray-50">
            {events.map((e) => {
              const dt = new Date(e.event_date + "T00:00:00");
              return (
                <li key={e.id} className="flex items-center gap-2 px-4 py-2 text-sm">
                  <span className="w-16 text-gray-500 text-xs whitespace-nowrap">{`${dt.getMonth() + 1}/${dt.getDate()}`}({DOW[dt.getDay()]})</span>
                  <span className="text-black flex-1">{e.title}{e.assignee && <span className="text-[11px] text-gray-400"> · {e.assignee}</span>}</span>
                </li>
              );
            })}
          </ul>
        )}
    </div>
  );
}
