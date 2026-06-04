// 업무루틴 + 일정 데이터 레이어 (browser-direct). 마이그 208.
// 2주(14일) 사이클: anchor=2024-01-01(월)=cycle day 1. day1~7=1주차 월~일, day8~14=2주차 월~일. 계속 순환.
// [[project_retail_work_routines]] [[feedback_retail_browser_supabase_direct]]
import { supabase } from "@/lib/supabase";

export const DOW = ["월", "화", "수", "목", "금", "토", "일"];
const ANCHOR = Date.UTC(2024, 0, 1); // 월요일 = cycle day 1

export function isoDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
// 그 날짜의 2주 사이클 day (1~14)
export function cycleDayOf(d: Date): number {
  const u = Date.UTC(d.getFullYear(), d.getMonth(), d.getDate());
  const days = Math.floor((u - ANCHOR) / 86400000);
  return (((days % 14) + 14) % 14) + 1;
}
// cycle day(1~14) → {week:1|2, dow:0~6(월~일)}
export function dayInfo(cd: number): { week: number; dow: number } {
  return { week: cd <= 7 ? 1 : 2, dow: (cd - 1) % 7 };
}

export interface Routine {
  id: string;
  assignee: string | null;
  title: string;
  cycle_days: number[];
  sort_order: number;
  is_active: boolean;
}
export interface ScheduleEvent {
  id: string;
  assignee: string | null;
  event_date: string;
  title: string;
  memo: string | null;
}

// ── 루틴 ──────────────────────────────
export async function loadRoutines(tenantId: string): Promise<Routine[]> {
  const { data } = await supabase
    .from("work_routines")
    .select("id, assignee, title, cycle_days, sort_order, is_active")
    .eq("tenant_id", tenantId)
    .eq("is_active", true)
    .order("sort_order")
    .order("created_at");
  return (data ?? []).map((r) => ({ ...r, cycle_days: (r.cycle_days ?? []) as number[] })) as Routine[];
}

export async function addRoutine(tenantId: string, title: string, assignee: string | null, cycleDays: number[]): Promise<string | null> {
  const { data, error } = await supabase
    .from("work_routines")
    .insert({ tenant_id: tenantId, title: title.trim(), assignee: assignee || null, cycle_days: cycleDays })
    .select("id")
    .single();
  if (error) { console.error("addRoutine:", error); return null; }
  return data.id;
}

export async function updateRoutine(id: string, patch: Partial<Pick<Routine, "title" | "assignee" | "cycle_days">>): Promise<void> {
  await supabase.from("work_routines").update({ ...patch, updated_at: new Date().toISOString() }).eq("id", id);
}

export async function deleteRoutine(id: string): Promise<void> {
  await supabase.from("work_routines").update({ is_active: false, updated_at: new Date().toISOString() }).eq("id", id);
}

// 특정 날짜에 done 인 routine_id Set (lazy: 체크된 것만 박제)
export async function loadChecks(routineIds: string[], dateIso: string): Promise<Set<string>> {
  if (routineIds.length === 0) return new Set();
  const { data } = await supabase
    .from("routine_checks")
    .select("routine_id")
    .in("routine_id", routineIds)
    .eq("check_date", dateIso)
    .eq("done", true);
  return new Set((data ?? []).map((r: { routine_id: string }) => r.routine_id));
}

export async function setCheck(routineId: string, dateIso: string, checkedBy: string | null): Promise<void> {
  await supabase.from("routine_checks").upsert(
    { routine_id: routineId, check_date: dateIso, done: true, checked_by: checkedBy, checked_at: new Date().toISOString() },
    { onConflict: "routine_id,check_date" }
  );
}
export async function unsetCheck(routineId: string, dateIso: string): Promise<void> {
  await supabase.from("routine_checks").delete().eq("routine_id", routineId).eq("check_date", dateIso);
}

// ── 일정 ──────────────────────────────
export async function loadEvents(tenantId: string, fromIso: string, toIso: string): Promise<ScheduleEvent[]> {
  const { data } = await supabase
    .from("schedule_events")
    .select("id, assignee, event_date, title, memo")
    .eq("tenant_id", tenantId)
    .gte("event_date", fromIso)
    .lte("event_date", toIso)
    .order("event_date");
  return (data ?? []) as ScheduleEvent[];
}
export async function addEvent(tenantId: string, dateIso: string, title: string, assignee: string | null, memo: string | null): Promise<string | null> {
  const { data, error } = await supabase
    .from("schedule_events")
    .insert({ tenant_id: tenantId, event_date: dateIso, title: title.trim(), assignee: assignee || null, memo: memo || null })
    .select("id")
    .single();
  if (error) { console.error("addEvent:", error); return null; }
  return data.id;
}
export async function deleteEvent(id: string): Promise<void> {
  await supabase.from("schedule_events").delete().eq("id", id);
}
