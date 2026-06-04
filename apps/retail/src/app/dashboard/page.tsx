"use client";

import { useEffect, useState } from "react";
import { styles } from "@/common/styles";
import { useTenant } from "@/lib/TenantContext";

// Retail 위젯형 대시보드. 좌측=빈 위젯 영역(추후), 우측 끝=날씨 위젯(Open-Meteo, 11일).
// 날씨 소스 교체 시 이 위젯 데이터부분만 바꾸면 됨 (KMA/AccuWeather = 키+server route).

interface DailyWx { date: string; code: number; tmax: number; tmin: number; pop: number | null; }
const DOW = ["일", "월", "화", "수", "목", "금", "토"];

function wx(code: number): string {
  if (code === 0) return "☀️";
  if (code <= 2) return "🌤️";
  if (code === 3) return "☁️";
  if (code === 45 || code === 48) return "🌫️";
  if (code >= 51 && code <= 57) return "🌦️";
  if (code >= 61 && code <= 67) return "🌧️";
  if (code >= 71 && code <= 77) return "🌨️";
  if (code >= 80 && code <= 82) return "🌧️";
  if (code >= 85 && code <= 86) return "🌨️";
  if (code >= 95) return "⛈️";
  return "·";
}

function WeatherWidget() {
  const [days, setDays] = useState<DailyWx[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const url =
          "https://api.open-meteo.com/v1/forecast" +
          "?latitude=37.5665&longitude=126.9780" +
          "&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max" +
          "&forecast_days=11&timezone=Asia%2FSeoul";
        const res = await fetch(url, { cache: "no-store" });
        const j = await res.json();
        if (cancelled) return;
        const d = j.daily;
        setDays((d?.time ?? []).map((t: string, i: number) => ({
          date: t,
          code: d.weather_code[i],
          tmax: d.temperature_2m_max[i],
          tmin: d.temperature_2m_min[i],
          pop: d.precipitation_probability_max?.[i] ?? null,
        })));
        setLoading(false);
      } catch {
        if (!cancelled) { setErr(true); setLoading(false); }
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const today = days[0]?.date;

  return (
    <div className="bg-white border border-gray-200 rounded-2xl overflow-hidden">
      <div className="px-3 py-2 border-b border-gray-100 flex items-center gap-1.5">
        <span className="text-sm font-bold text-black">11일 날씨</span>
        <span className="text-[11px] text-gray-400">서울</span>
        <span className="ml-auto text-[10px] text-gray-300">Open-Meteo</span>
      </div>
      {loading ? (
        <div className="text-xs text-gray-400 px-3 py-8 text-center">불러오는 중…</div>
      ) : err || days.length === 0 ? (
        <div className="text-xs text-gray-400 px-3 py-8 text-center">날씨를 불러오지 못했습니다.</div>
      ) : (
        <ul className="divide-y divide-gray-50">
          {days.map((d) => {
            const dt = new Date(d.date + "T00:00:00");
            const isToday = d.date === today;
            return (
              <li key={d.date} className={"flex items-center gap-2 px-3 py-1.5 text-xs" + (isToday ? " bg-sky-50/50" : "")}>
                <span className="w-11 text-gray-600 whitespace-nowrap">
                  {`${dt.getMonth() + 1}/${dt.getDate()}`}<span className="text-gray-400">({DOW[dt.getDay()]})</span>
                </span>
                <span className="w-5 text-center">{wx(d.code)}</span>
                <span className="w-9 text-right text-blue-500">{d.pop != null ? `${d.pop}%` : ""}</span>
                <span className="ml-auto whitespace-nowrap">
                  <span className="text-blue-600">{Math.round(d.tmin)}°</span>
                  <span className="text-gray-300">/</span>
                  <span className="text-rose-600">{Math.round(d.tmax)}°</span>
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

export default function DashboardHome() {
  const { tenant } = useTenant();
  return (
    <main className={styles.main}>
      <div className="flex gap-4 items-start">
        {/* 좌측 — 빈 위젯 영역 (추후 위젯 추가) */}
        <div className="flex-1 min-h-[460px] rounded-2xl border-2 border-dashed border-gray-200 flex items-center justify-center">
          <span className="text-xs text-gray-300">{tenant?.company_name ? `${tenant.company_name} · ` : ""}위젯 영역 (추후)</span>
        </div>
        {/* 우측 끝 — 날씨 위젯 (좁은 컬럼) */}
        <div className="w-72 shrink-0">
          <WeatherWidget />
        </div>
      </div>
    </main>
  );
}
