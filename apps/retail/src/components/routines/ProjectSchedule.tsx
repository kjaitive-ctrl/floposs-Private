"use client";

// 일정 — 월 달력(일~토 주 단위 줄바꿈) × 프로젝트 행. 마이그 208/213/217/234.
// 각 주 블록 = [날짜 헤더] + [프로젝트별 행]. 행 안에서는 기간 일정이 이어진 막대(band)로,
// 같은 날 여러 일정은 레인(lane)으로 쌓임(구글캘린더 월간뷰 방식, 주 경계에서 줄바꿈).
// 프로젝트 추가/수정/순서/삭제는 상단 프로젝트 바에서 인라인으로(장기과제 패널과 같은 감각).
// 프로젝트 삭제 = is_active=false(소프트) — 그 프로젝트 일정은 숨겨질 뿐 보존, 복원 가능.
// project_id 없는 일정 = (미분류) 행. 일정 등록/수정은 칸·막대 클릭 → 모달.
import { useCallback, useEffect, useState } from "react";
import { styles } from "@/common/styles";
import {
  isoDate, loadEvents, addEvent, deleteEvent, toggleEventDone, updateEvent,
  loadProjects, addProject, updateProject,
  type ScheduleEvent, type ScheduleProject,
} from "@/lib/routines";

const CAL_DOW = ["일", "월", "화", "수", "목", "금", "토"];
const PROJECT_COLORS: Record<string, { chip: string; dot: string }> = {
  sky:     { chip: "bg-sky-100 text-sky-800",         dot: "bg-sky-400" },
  amber:   { chip: "bg-amber-100 text-amber-800",     dot: "bg-amber-400" },
  emerald: { chip: "bg-emerald-100 text-emerald-800", dot: "bg-emerald-400" },
  violet:  { chip: "bg-violet-100 text-violet-800",   dot: "bg-violet-400" },
  rose:    { chip: "bg-rose-100 text-rose-800",       dot: "bg-rose-400" },
  lime:    { chip: "bg-lime-100 text-lime-800",       dot: "bg-lime-500" },
  cyan:    { chip: "bg-cyan-100 text-cyan-800",       dot: "bg-cyan-400" },
  fuchsia: { chip: "bg-fuchsia-100 text-fuchsia-800", dot: "bg-fuchsia-400" },
};
const COLOR_KEYS = Object.keys(PROJECT_COLORS);
const UNASSIGNED_CHIP = "bg-gray-200 text-gray-700";
const DONE_CHIP = "bg-gray-100 text-gray-400";
const UNASSIGNED = "__unassigned__";

function colorOf(key: string) { return PROJECT_COLORS[key] ?? PROJECT_COLORS.sky; }
function fmtMD(iso: string): string {
  const [, mo, da] = iso.split("-");
  return `${Number(mo)}/${Number(da)}`;
}

type DaySlot = { d: number; iso: string; inMonth: boolean };
type Seg = { e: ScheduleEvent; isStart: boolean; isEnd: boolean };
type WeekCol = { iso: string; lanes: (Seg | null)[] };

// 한 주(7일)의 일정에 레인(0,1,2..)을 배정. 같은 일정은 그 주 안에서 항상 같은 레인 →
// 이어진 막대로 보임(주 경계에서는 새로 배정 — 자연스러운 줄바꿈).
function layoutWeek(week: DaySlot[], events: ScheduleEvent[]): { maxLanes: number; cols: WeekCol[] } {
  const firstIso = week[0].iso;
  const lastIso = week[week.length - 1].iso;
  const clipped = events
    .filter((e) => e.event_date <= lastIso && e.end_date >= firstIso)
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
    const lanes: (Seg | null)[] = Array(maxLanes).fill(null);
    for (const p of placed) {
      if (slot.iso >= p.cs && slot.iso <= p.ce) {
        lanes[p.lane] = { e: p.e, isStart: slot.iso === p.cs, isEnd: slot.iso === p.ce };
      }
    }
    return { iso: slot.iso, lanes };
  });
  return { maxLanes, cols };
}

// 등록/수정 모달 상태
type EventDraft = {
  id: string | null; // null = 신규
  projectId: string; // UNASSIGNED = 미분류
  title: string;
  assignee: string;
  start: string;
  end: string;
  isDone: boolean;
};

const GRID_COLS = { gridTemplateColumns: "7.5rem repeat(7, minmax(5.5rem, 1fr))" };

export default function ProjectSchedule({ tenantId }: { tenantId: string }) {
  const today = new Date();
  const todayIso = isoDate(today);
  const [y, setY] = useState(today.getFullYear());
  const [m, setM] = useState(today.getMonth()); // 0~11
  const [events, setEvents] = useState<ScheduleEvent[]>([]);
  const [projects, setProjects] = useState<ScheduleProject[]>([]);
  const [archived, setArchived] = useState<ScheduleProject[]>([]);
  const [showArchived, setShowArchived] = useState(false);
  const [newProject, setNewProject] = useState("");
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameText, setRenameText] = useState("");
  const [draft, setDraft] = useState<EventDraft | null>(null);

  // 달력 칸: 그 달 1일이 속한 주의 일요일 ~ 말일이 속한 주의 토요일 (앞뒤 달 날짜 포함)
  const first = new Date(y, m, 1);
  const last = new Date(y, m + 1, 0);
  const gridStart = new Date(y, m, 1 - first.getDay());
  const gridEnd = new Date(y, m, last.getDate() + (6 - last.getDay()));
  const gridStartIso = isoDate(gridStart);
  const gridEndIso = isoDate(gridEnd);

  const weeks: DaySlot[][] = [];
  for (let d = new Date(gridStart); d <= gridEnd; d.setDate(d.getDate() + 1)) {
    if (d.getDay() === 0) weeks.push([]);
    weeks[weeks.length - 1].push({ d: d.getDate(), iso: isoDate(d), inMonth: d.getMonth() === m });
  }

  const reloadEvents = useCallback(async () => {
    setEvents(await loadEvents(tenantId, gridStartIso, gridEndIso));
  }, [tenantId, gridStartIso, gridEndIso]);
  const reloadProjects = useCallback(async () => {
    const [act, arc] = await Promise.all([loadProjects(tenantId, true), loadProjects(tenantId, false)]);
    setProjects(act);
    setArchived(arc);
  }, [tenantId]);
  useEffect(() => { reloadEvents(); }, [reloadEvents]);
  useEffect(() => { reloadProjects(); }, [reloadProjects]);

  function prevMonth() { if (m === 0) { setY(y - 1); setM(11); } else setM(m - 1); }
  function nextMonth() { if (m === 11) { setY(y + 1); setM(0); } else setM(m + 1); }
  function goToday() { setY(today.getFullYear()); setM(today.getMonth()); }

  // ── 행 구성: 활성 프로젝트 전부 + (미분류: 이 화면 범위에 미분류 일정 있을 때만) ──
  // 삭제(보관)된 프로젝트의 일정은 숨김(데이터는 보존).
  const activeIds = new Set(projects.map((p) => p.id));
  const unassignedEvents = events.filter((e) => !e.project_id);
  const rows: { key: string; label: string; dot: string; events: ScheduleEvent[] }[] = [
    ...projects.map((p) => ({
      key: p.id, label: p.name, dot: colorOf(p.color).dot,
      events: events.filter((e) => e.project_id === p.id),
    })),
    ...(unassignedEvents.length > 0
      ? [{ key: UNASSIGNED, label: "(미분류)", dot: "bg-gray-300", events: unassignedEvents }]
      : []),
  ];
  const projectColor = new Map(projects.map((p) => [p.id, p.color]));
  function chipClass(e: ScheduleEvent): string {
    if (e.is_done) return DONE_CHIP;
    if (e.project_id && activeIds.has(e.project_id)) return colorOf(projectColor.get(e.project_id)!).chip;
    return UNASSIGNED_CHIP;
  }

  // ── 프로젝트 인라인 관리 ──
  async function createProject() {
    const name = newProject.trim();
    if (!name) return;
    setNewProject("");
    const color = COLOR_KEYS[projects.length % COLOR_KEYS.length];
    const maxOrder = projects.reduce((mx, p) => Math.max(mx, p.sort_order), 0);
    await addProject(tenantId, name, color, maxOrder + 1);
    reloadProjects();
  }
  function startRename(p: ScheduleProject) { setRenamingId(p.id); setRenameText(p.name); }
  async function saveRename() {
    if (!renamingId) return;
    const id = renamingId;
    const name = renameText.trim();
    setRenamingId(null);
    if (!name) return;
    setProjects((prev) => prev.map((p) => (p.id === id ? { ...p, name } : p))); // optimistic
    await updateProject(id, { name });
  }
  async function cycleColor(p: ScheduleProject) {
    const next = COLOR_KEYS[(COLOR_KEYS.indexOf(p.color) + 1) % COLOR_KEYS.length];
    setProjects((prev) => prev.map((x) => (x.id === p.id ? { ...x, color: next } : x))); // optimistic
    await updateProject(p.id, { color: next });
  }
  // 순서 이동: 이웃과 자리 바꾼 뒤 index 로 sort_order 재정렬(어긋난 것만 업데이트)
  async function move(idx: number, dir: -1 | 1) {
    const to = idx + dir;
    if (to < 0 || to >= projects.length) return;
    const next = [...projects];
    [next[idx], next[to]] = [next[to], next[idx]];
    const changed = next
      .map((p, i) => ({ p, i: i + 1 }))
      .filter(({ p, i }) => p.sort_order !== i);
    setProjects(next.map((p, i) => ({ ...p, sort_order: i + 1 }))); // optimistic
    await Promise.all(changed.map(({ p, i }) => updateProject(p.id, { sort_order: i })));
  }
  async function removeProject(p: ScheduleProject) {
    if (!confirm(`'${p.name}' 프로젝트를 삭제할까요?\n등록된 일정은 지워지지 않고 '삭제된 프로젝트'에서 복원할 수 있습니다.`)) return;
    setProjects((prev) => prev.filter((x) => x.id !== p.id)); // optimistic
    await updateProject(p.id, { is_active: false });
    reloadProjects();
  }
  async function restoreProject(p: ScheduleProject) {
    const maxOrder = projects.reduce((mx, x) => Math.max(mx, x.sort_order), 0);
    setArchived((prev) => prev.filter((x) => x.id !== p.id)); // optimistic
    await updateProject(p.id, { is_active: true, sort_order: maxOrder + 1 });
    reloadProjects();
  }

  // ── 일정 등록/수정 모달 ──
  function openAdd(rowKey: string, iso: string) {
    setDraft({ id: null, projectId: rowKey, title: "", assignee: "", start: iso, end: iso, isDone: false });
  }
  function openEdit(e: ScheduleEvent) {
    setDraft({
      id: e.id,
      projectId: e.project_id && activeIds.has(e.project_id) ? e.project_id : UNASSIGNED,
      title: e.title, assignee: e.assignee ?? "", start: e.event_date, end: e.end_date, isDone: e.is_done,
    });
  }
  async function saveDraft() {
    if (!draft || !draft.title.trim()) return;
    const projectId = draft.projectId === UNASSIGNED ? null : draft.projectId;
    const end = draft.end >= draft.start ? draft.end : draft.start;
    const d = draft;
    setDraft(null);
    if (d.id === null) {
      await addEvent(tenantId, d.start, d.title, d.assignee || null, null, end, projectId);
    } else {
      await updateEvent(d.id, { title: d.title.trim(), assignee: d.assignee || null, event_date: d.start, end_date: end, project_id: projectId });
    }
    reloadEvents();
  }
  async function toggleDraftDone() {
    if (!draft?.id) return;
    const isDone = !draft.isDone;
    setDraft({ ...draft, isDone });
    setEvents((prev) => prev.map((x) => (x.id === draft.id ? { ...x, is_done: isDone } : x))); // optimistic
    await toggleEventDone(draft.id, isDone);
  }
  async function removeDraft() {
    if (!draft?.id || !confirm("이 일정을 삭제할까요?")) return;
    const id = draft.id;
    setDraft(null);
    setEvents((prev) => prev.filter((x) => x.id !== id)); // optimistic
    await deleteEvent(id);
  }

  return (
    <div className="space-y-3">
      {/* 프로젝트 바 — 인라인 추가/수정/순서/색/삭제 */}
      <div className="bg-white border border-gray-200 rounded-xl p-3">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-xs font-semibold text-gray-500 uppercase tracking-wider mr-1">프로젝트</span>
          {projects.map((p, i) => renamingId === p.id ? (
            <span key={p.id} className="flex items-center gap-1">
              <input value={renameText} onChange={(e) => setRenameText(e.target.value)} autoFocus
                onKeyDown={(e) => { if (e.key === "Enter") saveRename(); if (e.key === "Escape") setRenamingId(null); }}
                onBlur={saveRename}
                className={`${styles.inputMd} w-32 px-2 py-1 text-xs`} />
            </span>
          ) : (
            <span key={p.id} className="group flex items-center gap-1 pl-1.5 pr-2 py-1 bg-gray-50 border border-gray-200 rounded-full text-xs">
              <button onClick={() => cycleColor(p)} title="색 바꾸기"
                className={`w-3 h-3 rounded-full shrink-0 ${colorOf(p.color).dot}`} />
              <button onClick={() => startRename(p)} title="이름 수정" className="text-black">{p.name}</button>
              <span className="hidden group-hover:flex items-center gap-1 ml-0.5">
                <button onClick={() => move(i, -1)} disabled={i === 0} title="앞으로"
                  className="text-gray-300 hover:text-black disabled:invisible">‹</button>
                <button onClick={() => move(i, 1)} disabled={i === projects.length - 1} title="뒤로"
                  className="text-gray-300 hover:text-black disabled:invisible">›</button>
                <button onClick={() => removeProject(p)} title="삭제" className="text-gray-300 hover:text-rose-500">✕</button>
              </span>
            </span>
          ))}
          <span className="flex items-center gap-1">
            <input value={newProject} onChange={(e) => setNewProject(e.target.value)} placeholder="+ 프로젝트 추가"
              onKeyDown={(e) => { if (e.key === "Enter") createProject(); }}
              className={`${styles.inputMd} w-36 px-2 py-1 text-xs`} />
            {newProject.trim() && <button onClick={createProject} className={`${styles.btnSmall} shrink-0`}>추가</button>}
          </span>
          {archived.length > 0 && (
            <button onClick={() => setShowArchived(!showArchived)} className="ml-auto text-xs text-gray-400 hover:text-black">
              삭제된 프로젝트 ({archived.length}) {showArchived ? "▴" : "▾"}
            </button>
          )}
        </div>
        {showArchived && archived.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5 mt-2 pt-2 border-t border-gray-100">
            {archived.map((p) => (
              <span key={p.id} className="flex items-center gap-1 pl-1.5 pr-2 py-1 bg-gray-50 border border-dashed border-gray-300 rounded-full text-xs text-gray-400">
                <span className={`w-3 h-3 rounded-full shrink-0 opacity-40 ${colorOf(p.color).dot}`} />
                {p.name}
                <button onClick={() => restoreProject(p)} className="ml-1 text-gray-400 hover:text-black">복원</button>
              </span>
            ))}
          </div>
        )}
      </div>

      {/* 달력 — 주 블록 × 프로젝트 행 */}
      <div className="bg-white border border-gray-200 rounded-xl p-4">
        <div className="flex items-center justify-center gap-2 mb-3 relative">
          <button onClick={prevMonth} className="text-gray-400 hover:text-black text-2xl px-3 py-1 leading-none">‹</button>
          <span className="text-lg font-bold text-black">{y}년 {m + 1}월</span>
          <button onClick={nextMonth} className="text-gray-400 hover:text-black text-2xl px-3 py-1 leading-none">›</button>
          <button onClick={goToday} className={`${styles.btnSmallGhost} absolute right-0`}>오늘</button>
        </div>

        <div className="overflow-x-auto">
          <div className="min-w-[46rem] space-y-3">
            {weeks.map((week, wi) => (
              <div key={wi} className="border border-gray-100 rounded-lg overflow-hidden">
                {/* 주 날짜 헤더 */}
                <div className="grid bg-gray-50 border-b border-gray-100" style={GRID_COLS}>
                  <div className="sticky left-0 bg-gray-50 z-10" />
                  {week.map((slot, ci) => {
                    const isToday = slot.iso === todayIso;
                    const dowColor = ci === 0 ? "text-rose-400" : ci === 6 ? "text-blue-400" : "text-gray-400";
                    return (
                      <div key={slot.iso}
                        className={"flex items-center gap-1 px-1.5 py-1 text-xs " + (slot.inMonth ? "" : "opacity-40")}>
                        <span className={dowColor}>{CAL_DOW[ci]}</span>
                        <span className={"w-5 h-5 flex items-center justify-center rounded-full " +
                          (isToday ? "bg-black text-white font-bold" : "text-gray-700")}>
                          {slot.d}
                        </span>
                      </div>
                    );
                  })}
                </div>

                {/* 프로젝트 행 */}
                {rows.length === 0 ? (
                  <div className="text-xs text-gray-300 py-3 text-center">위에서 프로젝트를 추가하세요</div>
                ) : rows.map((row) => {
                  const { cols } = layoutWeek(week, row.events);
                  return (
                    <div key={row.key} className="grid border-b border-gray-50 last:border-b-0" style={GRID_COLS}>
                      <div className="sticky left-0 bg-white z-10 flex items-start gap-1.5 px-2 py-1.5 text-xs border-r border-gray-100">
                        <span className={`mt-[3px] w-2 h-2 rounded-full shrink-0 ${row.dot}`} />
                        <span className="text-gray-700 truncate" title={row.label}>{row.label}</span>
                      </div>
                      {cols.map((col, ci) => {
                        const inMonth = week[ci].inMonth;
                        const isToday = col.iso === todayIso;
                        return (
                          <div key={col.iso} onClick={() => openAdd(row.key, col.iso)}
                            className={"min-h-[30px] py-1 flex flex-col gap-[2px] cursor-pointer border-r border-gray-50 last:border-r-0 " +
                              (isToday ? "bg-amber-50/50 " : "hover:bg-gray-50 ") + (inMonth ? "" : "opacity-50")}>
                            {col.lanes.map((seg, li) => {
                              if (!seg) return <div key={li} className="h-[18px]" />;
                              const round = (seg.isStart ? "rounded-l ml-1 " : "") + (seg.isEnd ? "rounded-r mr-1" : "");
                              const showLabel = seg.isStart || ci === 0;
                              const tip = seg.e.title + (seg.e.assignee ? ` · ${seg.e.assignee}` : "") +
                                (seg.e.event_date !== seg.e.end_date ? ` (${fmtMD(seg.e.event_date)}~${fmtMD(seg.e.end_date)})` : "");
                              return (
                                <div key={li} title={tip}
                                  onClick={(ev) => { ev.stopPropagation(); openEdit(seg.e); }}
                                  className={`h-[18px] leading-[18px] text-[11px] px-1 truncate cursor-pointer hover:brightness-95 ${chipClass(seg.e)} ${round} ${seg.e.is_done ? "line-through" : ""}`}>
                                  {showLabel ? seg.e.title : " "}
                                </div>
                              );
                            })}
                          </div>
                        );
                      })}
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* 일정 등록/수정 모달 */}
      {draft && (
        <div className={styles.modalOverlay} onClick={() => setDraft(null)}>
          <div className={`${styles.modalContent} max-w-md`} onClick={(e) => e.stopPropagation()}>
            <div className={styles.modalHeader}>
              <div className="text-base font-bold text-black">{draft.id ? "일정 수정" : "일정 추가"}</div>
            </div>
            <div className={styles.modalBody}>
              <div>
                <label className={styles.modalLabel}>프로젝트</label>
                <select value={draft.projectId} onChange={(e) => setDraft({ ...draft, projectId: e.target.value })}
                  className={styles.modalInput}>
                  {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                  <option value={UNASSIGNED}>(미분류)</option>
                </select>
              </div>
              <div>
                <label className={styles.modalLabel}>제목 *</label>
                <input value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} autoFocus
                  onKeyDown={(e) => { if (e.key === "Enter") saveDraft(); }} className={styles.modalInput} />
              </div>
              <div>
                <label className={styles.modalLabel}>담당</label>
                <input value={draft.assignee} onChange={(e) => setDraft({ ...draft, assignee: e.target.value })}
                  onKeyDown={(e) => { if (e.key === "Enter") saveDraft(); }} className={`${styles.modalInput} w-32`} />
              </div>
              <div>
                <label className={styles.modalLabel}>기간 (하루 일정이면 같은 날짜)</label>
                <div className="flex items-center gap-1">
                  <input type="date" value={draft.start}
                    onChange={(e) => setDraft({ ...draft, start: e.target.value, end: draft.end < e.target.value ? e.target.value : draft.end })}
                    className={`${styles.modalInput} min-w-0 flex-1`} />
                  <span className="text-xs text-gray-400 shrink-0">~</span>
                  <input type="date" value={draft.end} min={draft.start}
                    onChange={(e) => setDraft({ ...draft, end: e.target.value })}
                    className={`${styles.modalInput} min-w-0 flex-1`} />
                </div>
              </div>
            </div>
            <div className={styles.modalFooter}>
              {draft.id && (
                <>
                  <button onClick={removeDraft} className="text-xs text-gray-400 hover:text-rose-500 mr-1">삭제</button>
                  <button onClick={toggleDraftDone}
                    className={"text-xs " + (draft.isDone ? "text-emerald-600 hover:text-emerald-700" : "text-gray-400 hover:text-emerald-600")}>
                    {draft.isDone ? "✓ 완료됨" : "완료 표시"}
                  </button>
                </>
              )}
              <span className="flex-1" />
              <button onClick={() => setDraft(null)} className={styles.btnSecondary}>취소</button>
              <button onClick={saveDraft} disabled={!draft.title.trim()} className={styles.btnPrimary}>
                {draft.id ? "저장" : "추가"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
