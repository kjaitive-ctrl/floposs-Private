// 장기과제 — 날짜 미정 할일 목록 (업무루틴 페이지 좌측 패널). 마이그 232.
// [[project_retail_work_routines]] [[feedback_retail_browser_supabase_direct]]
import { supabase } from "@/lib/supabase";

export interface LongTermTask {
  id: string;
  title: string;
  is_done: boolean;
  sort_order: number;
}

export async function loadLongTermTasks(tenantId: string): Promise<LongTermTask[]> {
  const { data } = await supabase
    .from("long_term_tasks")
    .select("id, title, is_done, sort_order")
    .eq("tenant_id", tenantId)
    .order("sort_order")
    .order("created_at");
  return (data ?? []) as LongTermTask[];
}

export async function addLongTermTask(tenantId: string, title: string): Promise<string | null> {
  const { data, error } = await supabase
    .from("long_term_tasks")
    .insert({ tenant_id: tenantId, title: title.trim() })
    .select("id")
    .single();
  if (error) { console.error("addLongTermTask:", error); return null; }
  return data.id;
}

export async function toggleLongTermTask(id: string, isDone: boolean): Promise<void> {
  await supabase.from("long_term_tasks").update({ is_done: isDone, updated_at: new Date().toISOString() }).eq("id", id);
}

export async function updateLongTermTask(id: string, title: string): Promise<void> {
  await supabase.from("long_term_tasks").update({ title: title.trim(), updated_at: new Date().toISOString() }).eq("id", id);
}

export async function deleteLongTermTask(id: string): Promise<void> {
  await supabase.from("long_term_tasks").delete().eq("id", id);
}
