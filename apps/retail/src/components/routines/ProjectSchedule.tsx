"use client";

// 일정 — 월 달력(일~토 주 단위 줄바꿈) × 프로젝트 행. 마이그 208/213/217/234.
// 각 주 블록 = [날짜 헤더] + [프로젝트별 행]. 행 안에서는 기간 일정이 이어진 막대(band)로,
// 같은 날 여러 일정은 레인(lane)으로 쌓임(구글캘린더 월간뷰 방식, 주 경계에서 줄바꿈).
// 프로젝트 추가/수정/순서/삭제는 상단 프로젝트 바에서 인라인으로(장기과제 패널과 같은 감각).
// 프로젝트 삭제 = is_active=false(소프트) — 그 프로젝트 일정은 숨겨질 뿐 보존, 복원 가능.
// project_id 없는 일정 = (미분류) 행.
// 등록/수정 = 상단 고정 등록줄(모달 없음). 칸 클릭 → 등록줄에 프로젝트·날짜 채움,
// 막대 클릭 → 등록줄이 수정 모드. 마우스 드래그: 빈 칸 끌기=기간 선택, 막대 끌기=이동(다른
// 프로젝트 행에 놓으면 프로젝트도 이동), 막대 양 끝 손잡이=시작/종료일 조절. 놓는 즉시 저장.
// 터치는 드래그 없이 탭만(스크롤 충돌) — 등록줄 ‹ › 로 하루씩 이동.
import { useCallback, useEffect, useRef, useState } from "react";
import { styles } from "@/common/styles";
import {
  isoDate, loadEvents, addEvent, deleteEvent, toggleEventDone, updateEvent,
  loadProjects, addProject, updateProject,
  type ScheduleEvent, type ScheduleProject,
} from "@/lib/routines";
import { loadHolidays, shortHolidayName, type HolidayMap } from "@/lib/holidays";

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
const DRAG_THRESHOLD_PX = 4;

function colorOf(key: string) { return PROJECT_COLORS[key] ?? PROJECT_COLORS.sky; }
function fmtMD(iso: string): string {
  const [, mo, da] = iso.split("-");
  return `${Number(mo)}/${Number(da)}`;
}
function isoToUtc(iso: string): number {
  const [yy, mm, dd] = iso.split("-").map(Number);
  return Date.UTC(yy, mm - 1, dd);
}
function dayDiff(fromIso: string, toIso: string): number {
  return Math.round((isoToUtc(toIso) - isoToUtc(fromIso)) / 86400000);
}
function addDays(iso: string, n: number): string {
  const d = new Date(isoToUtc(iso) + n * 86400000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
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

// 등록줄 상태. id=null → 신규 등록 모드, id 있음 → 수정 모드
type Form = {
  id: string | null;
  projectId: string; // UNASSIGNED = 미분류
  title: string;
  assignee: string;
  start: string;
  end: string;
  isDone: boolean;
};

// 드래그 상태. select=빈 칸 끌어 기간 선택, move=막대 이동, resize-*=막대 끝 조절
type Drag = {
  kind: "select" | "move" | "resize-start" | "resize-end";
  ev: ScheduleEvent | null;
  anchorRow: string;
  anchorIso: string;
  curRow: string;
  curIso: string;
  x0: number;
  y0: number;
  moved: boolean;
  mouse: boolean; // 터치/펜은 드래그 X (탭만)
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
  const [form, setForm] = useState<Form>({
    id: null, projectId: UNASSIGNED, title: "", assignee: "", start: todayIso, end: todayIso, isDone: false,
  });
  const [drag, setDrag] = useState<Drag | null>(null);
  const dragRef = useRef<Drag | null>(null);
  const titleRef = useRef<HTMLInputElement>(null);

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
    return act;
  }, [tenantId]);
  useEffect(() => { reloadEvents(); }, [reloadEvents]);
  // 공휴일(대체공휴일 포함) — 날짜 헤더 빨간색+이름 표시용. 달력 범위가 연말/연초에 걸치면 두 해 모두
  const [holidays, setHolidays] = useState<HolidayMap>({});
  const gridStartYear = gridStart.getFullYear();
  const gridEndYear = gridEnd.getFullYear();
  useEffect(() => {
    loadHolidays([gridStartYear, gridEndYear]).then(setHolidays);
  }, [gridStartYear, gridEndYear]);
  useEffect(() => {
    // 첫 로드 시 등록줄 프로젝트 기본값 = 첫 프로젝트
    reloadProjects().then((act) => {
      if (act.length > 0) setForm((f) => (f.id === null && f.projectId === UNASSIGNED ? { ...f, projectId: act[0].id } : f));
    });
  }, [reloadProjects]);

  const activeIds = new Set(projects.map((p) => p.id));
  const formProjectValid = form.projectId === UNASSIGNED || activeIds.has(form.projectId);

  function prevMonth() { if (m === 0) { setY(y - 1); setM(11); } else setM(m - 1); }
  function nextMonth() { if (m === 11) { setY(y + 1); setM(0); } else setM(m + 1); }
  function goToday() { setY(today.getFullYear()); setM(today.getMonth()); }

  // ── 드래그 미리보기: 끄는 중인 일정은 예상 위치로 그림 ──
  function dragResult(dr: Drag): ScheduleEvent | null {
    if (!dr.ev || !dr.moved) return null;
    const e = dr.ev;
    if (dr.kind === "move") {
      const delta = dayDiff(dr.anchorIso, dr.curIso);
      return {
        ...e,
        event_date: addDays(e.event_date, delta),
        end_date: addDays(e.end_date, delta),
        project_id: dr.curRow === UNASSIGNED ? null : dr.curRow,
      };
    }
    if (dr.kind === "resize-end") return { ...e, end_date: dr.curIso < e.event_date ? e.event_date : dr.curIso };
    if (dr.kind === "resize-start") return { ...e, event_date: dr.curIso > e.end_date ? e.end_date : dr.curIso };
    return null;
  }
  const preview = drag ? dragResult(drag) : null;
  const shown = preview ? events.map((e) => (e.id === preview.id ? preview : e)) : events;
  const selRange = drag && drag.kind === "select"
    ? { row: drag.anchorRow, from: drag.anchorIso < drag.curIso ? drag.anchorIso : drag.curIso, to: drag.anchorIso < drag.curIso ? drag.curIso : drag.anchorIso }
    : null;

  // ── 행 구성: 활성 프로젝트 전부 + (미분류: 이 화면 범위에 미분류 일정 있을 때만) ──
  // 삭제(보관)된 프로젝트의 일정은 숨김(데이터는 보존).
  const unassignedEvents = shown.filter((e) => !e.project_id);
  const rows: { key: string; label: string; dot: string; events: ScheduleEvent[] }[] = [
    ...projects.map((p) => ({
      key: p.id, label: p.name, dot: colorOf(p.color).dot,
      events: shown.filter((e) => e.project_id === p.id),
    })),
    ...(unassignedEvents.length > 0 || drag?.kind === "move"
      ? [{ key: UNASSIGNED, label: "(미분류)", dot: "bg-gray-300", events: unassignedEvents }]
      : []),
  ];
  const projectColor = new Map(projects.map((p) => [p.id, p.color]));
  function chipClass(e: ScheduleEvent): string {
    if (e.is_done) return DONE_CHIP;
    if (e.project_id && activeIds.has(e.project_id)) return colorOf(projectColor.get(e.project_id)!).chip;
    return UNASSIGNED_CHIP;
  }

  // ── 등록줄 ──
  function fillNew(rowKey: string, start: string, end: string) {
    setForm((f) => ({
      id: null, projectId: rowKey, start, end, isDone: false,
      // 수정 모드였다면 내용 비움, 신규 입력 중이었다면 쓰던 제목/담당 유지
      title: f.id ? "" : f.title, assignee: f.id ? "" : f.assignee,
    }));
    setTimeout(() => titleRef.current?.focus(), 0);
  }
  function loadEdit(e: ScheduleEvent) {
    setForm({
      id: e.id,
      projectId: e.project_id && activeIds.has(e.project_id) ? e.project_id : UNASSIGNED,
      title: e.title, assignee: e.assignee ?? "", start: e.event_date, end: e.end_date, isDone: e.is_done,
    });
    setTimeout(() => titleRef.current?.focus(), 0);
  }
  function resetForm() {
    setForm((f) => ({ ...f, id: null, title: "", assignee: "", isDone: false }));
  }
  async function submitForm(f: Form = form) {
    if (!f.title.trim()) return;
    const projectId = f.projectId === UNASSIGNED ? null : f.projectId;
    const end = f.end >= f.start ? f.end : f.start;
    if (f.id === null) {
      setForm({ ...f, title: "" }); // 프로젝트·날짜·담당 유지 → 연속 입력
      await addEvent(tenantId, f.start, f.title, f.assignee || null, null, end, projectId);
    } else {
      const patch = { title: f.title.trim(), assignee: f.assignee || null, event_date: f.start, end_date: end, project_id: projectId };
      setEvents((prev) => prev.map((x) => (x.id === f.id ? { ...x, ...patch } : x))); // optimistic
      resetForm();
      await updateEvent(f.id, patch);
    }
    reloadEvents();
  }
  // ‹ › 하루씩 이동. 수정 모드면 즉시 저장(드래그와 같은 감각)
  async function nudge(n: number) {
    const f = { ...form, start: addDays(form.start, n), end: addDays(form.end, n) };
    setForm(f);
    if (f.id && f.title.trim()) {
      const projectId = f.projectId === UNASSIGNED ? null : f.projectId;
      const patch = { title: f.title.trim(), assignee: f.assignee || null, event_date: f.start, end_date: f.end, project_id: projectId };
      setEvents((prev) => prev.map((x) => (x.id === f.id ? { ...x, ...patch } : x))); // optimistic
      await updateEvent(f.id, patch);
    }
  }
  async function toggleFormDone() {
    if (!form.id) return;
    const id = form.id;
    const isDone = !form.isDone;
    setForm({ ...form, isDone });
    setEvents((prev) => prev.map((x) => (x.id === id ? { ...x, is_done: isDone } : x))); // optimistic
    await toggleEventDone(id, isDone);
  }
  async function removeFormEvent() {
    if (!form.id || !confirm("이 일정을 삭제할까요?")) return;
    const id = form.id;
    resetForm();
    setEvents((prev) => prev.filter((x) => x.id !== id)); // optimistic
    await deleteEvent(id);
  }

  // ── 드래그(포인터) ──
  function beginDrag(ev: React.PointerEvent, kind: Drag["kind"], rowKey: string, iso: string, target: ScheduleEvent | null) {
    if (ev.button !== 0) return;
    ev.stopPropagation();
    if (ev.pointerType === "mouse") ev.preventDefault(); // 텍스트 선택 방지
    const dr: Drag = {
      kind, ev: target, anchorRow: rowKey, anchorIso: iso, curRow: rowKey, curIso: iso,
      x0: ev.clientX, y0: ev.clientY, moved: false, mouse: ev.pointerType === "mouse",
    };
    dragRef.current = dr;
    setDrag(dr);
  }

  useEffect(() => {
    if (!drag) return;
    function onMove(pe: PointerEvent) {
      const dr = dragRef.current;
      if (!dr) return;
      const far = Math.abs(pe.clientX - dr.x0) + Math.abs(pe.clientY - dr.y0) > DRAG_THRESHOLD_PX;
      if (!dr.mouse) {
        if (far) { dragRef.current = null; setDrag(null); } // 터치 = 스크롤로 간주, 취소
        return;
      }
      const cell = (document.elementFromPoint(pe.clientX, pe.clientY) as HTMLElement | null)?.closest<HTMLElement>("[data-iso]");
      const next: Drag = { ...dr, moved: dr.moved || far };
      if (cell) {
        next.curIso = cell.dataset.iso!;
        // 이동만 다른 행으로 넘어감. 기간 선택/끝 조절은 시작 행 고정
        if (dr.kind === "move") next.curRow = cell.dataset.row!;
      }
      if (next.curIso !== dr.curIso || next.curRow !== dr.curRow || next.moved !== dr.moved) {
        dragRef.current = next;
        setDrag(next);
      }
    }
    async function onUp() {
      const dr = dragRef.current;
      dragRef.current = null;
      setDrag(null);
      if (!dr) return;
      if (dr.kind === "select") {
        const [s, e] = dr.anchorIso < dr.curIso ? [dr.anchorIso, dr.curIso] : [dr.curIso, dr.anchorIso];
        fillNew(dr.anchorRow, s, dr.moved ? e : s);
        return;
      }
      if (!dr.ev) return;
      if (!dr.moved) { loadEdit(dr.ev); return; } // 클릭 = 수정 모드
      const r = dragResult(dr);
      if (!r) return;
      const patch = { event_date: r.event_date, end_date: r.end_date, project_id: r.project_id };
      setEvents((prev) => prev.map((x) => (x.id === r.id ? { ...x, ...patch } : x))); // optimistic
      // 등록줄에 같은 일정이 수정 중이면 날짜/프로젝트 동기화
      setForm((f) => (f.id === r.id
        ? { ...f, start: r.event_date, end: r.end_date, projectId: r.project_id ?? UNASSIGNED }
        : f));
      await updateEvent(r.id, patch);
    }
    function onCancel() { dragRef.current = null; setDrag(null); }
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
    };
  }, [drag !== null]); // eslint-disable-line react-hooks/exhaustive-deps

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
    if (form.projectId === p.id) setForm((f) => ({ ...f, projectId: UNASSIGNED }));
    await updateProject(p.id, { is_active: false });
    reloadProjects();
  }
  async function restoreProject(p: ScheduleProject) {
    const maxOrder = projects.reduce((mx, x) => Math.max(mx, x.sort_order), 0);
    setArchived((prev) => prev.filter((x) => x.id !== p.id)); // optimistic
    await updateProject(p.id, { is_active: true, sort_order: maxOrder + 1 });
    reloadProjects();
  }

  const editing = form.id !== null;
  const smallInput = `${styles.inputMd} px-2 py-1.5 text-sm`;

  return (
    <div className="space-y-3">
      {/* 프로젝트 바 + 등록줄 — 스크롤해도 상단 고정 */}
      <div className="sticky top-12 z-20 bg-white border border-gray-200 rounded-xl shadow-sm">
        <div className="p-3 pb-2">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-xs font-semibold text-gray-500 uppercase tracking-wider mr-1">프로젝트</span>
            {projects.map((p, i) => renamingId === p.id ? (
              <input key={p.id} value={renameText} onChange={(e) => setRenameText(e.target.value)} autoFocus
                onKeyDown={(e) => { if (e.key === "Enter") saveRename(); if (e.key === "Escape") setRenamingId(null); }}
                onBlur={saveRename}
                className={`${styles.inputMd} w-32 px-2 py-1 text-xs`} />
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

        {/* 등록줄 (신규/수정 겸용) */}
        <div className={"flex flex-wrap items-center gap-1.5 px-3 py-2 border-t rounded-b-xl " +
          (editing ? "bg-amber-50 border-amber-200" : "bg-gray-50 border-gray-100")}>
          {editing && <span className="text-xs font-bold text-amber-700 shrink-0">수정중 ▸</span>}
          <select value={formProjectValid ? form.projectId : UNASSIGNED}
            onChange={(e) => setForm({ ...form, projectId: e.target.value })}
            className={`${smallInput} w-auto max-w-[9rem]`}>
            {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            <option value={UNASSIGNED}>(미분류)</option>
          </select>
          <input ref={titleRef} value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })}
            placeholder="일정 제목 (Enter)"
            onKeyDown={(e) => { if (e.key === "Enter") submitForm(); if (e.key === "Escape" && editing) resetForm(); }}
            className={`${smallInput} flex-1 min-w-[10rem] w-auto`} />
          <input value={form.assignee} onChange={(e) => setForm({ ...form, assignee: e.target.value })}
            placeholder="담당" onKeyDown={(e) => { if (e.key === "Enter") submitForm(); }}
            className={`${smallInput} w-16`} />
          <div className="flex items-center gap-0.5">
            <button onClick={() => nudge(-1)} title="하루 앞으로" className="px-1.5 text-gray-400 hover:text-black text-lg leading-none">‹</button>
            <input type="date" value={form.start}
              onChange={(e) => setForm({ ...form, start: e.target.value, end: form.end < e.target.value ? e.target.value : form.end })}
              className={`${smallInput} w-[8.5rem]`} />
            <span className="text-xs text-gray-400">~</span>
            <input type="date" value={form.end} min={form.start}
              onChange={(e) => setForm({ ...form, end: e.target.value })}
              className={`${smallInput} w-[8.5rem]`} />
            <button onClick={() => nudge(1)} title="하루 뒤로" className="px-1.5 text-gray-400 hover:text-black text-lg leading-none">›</button>
          </div>
          <button onClick={() => submitForm()} disabled={!form.title.trim()} className={`${styles.btnPrimary} py-1.5`}>
            {editing ? "저장" : "추가"}
          </button>
          {editing && (
            <>
              <button onClick={toggleFormDone}
                className={"text-xs " + (form.isDone ? "text-emerald-600 hover:text-emerald-700" : "text-gray-400 hover:text-emerald-600")}>
                {form.isDone ? "✓ 완료됨" : "완료"}
              </button>
              <button onClick={removeFormEvent} className="text-xs text-gray-400 hover:text-rose-500">삭제</button>
              <button onClick={resetForm} className="text-xs text-gray-400 hover:text-black">취소</button>
            </>
          )}
        </div>
      </div>

      {/* 달력 — 주 블록 × 프로젝트 행 */}
      <div className="bg-white border border-gray-200 rounded-xl p-4">
        <div className="flex items-center justify-center gap-2 mb-3 relative">
          <button onClick={prevMonth} className="text-gray-400 hover:text-black text-2xl px-3 py-1 leading-none">‹</button>
          <span className="text-lg font-bold text-black">{y}년 {m + 1}월</span>
          <button onClick={nextMonth} className="text-gray-400 hover:text-black text-2xl px-3 py-1 leading-none">›</button>
          <button onClick={goToday} className={`${styles.btnSmallGhost} absolute right-0`}>오늘</button>
        </div>

        <div className={"overflow-x-auto " + (drag?.moved ? "select-none" : "")}
          style={drag?.moved ? { cursor: drag.kind === "move" ? "grabbing" : drag.kind === "select" ? "cell" : "ew-resize" } : undefined}>
          <div className="min-w-[46rem] space-y-3">
            {weeks.map((week, wi) => (
              <div key={wi} className="border border-gray-100 rounded-lg overflow-hidden">
                {/* 주 날짜 헤더 */}
                <div className="grid bg-gray-50 border-b border-gray-100" style={GRID_COLS}>
                  <div className="sticky left-0 bg-gray-50 z-10" />
                  {week.map((slot, ci) => {
                    const isToday = slot.iso === todayIso;
                    const holiday = holidays[slot.iso];
                    const dowColor = ci === 0 || holiday ? "text-rose-400" : ci === 6 ? "text-blue-400" : "text-gray-400";
                    return (
                      <div key={slot.iso} title={holiday ? holiday.join(", ") : undefined}
                        className={"flex items-center gap-1 px-1.5 py-1 text-xs min-w-0 " + (slot.inMonth ? "" : "opacity-40")}>
                        <span className={dowColor}>{CAL_DOW[ci]}</span>
                        <span className={"w-5 h-5 shrink-0 flex items-center justify-center rounded-full " +
                          (isToday ? "bg-black text-white font-bold" : holiday ? "text-rose-500" : "text-gray-700")}>
                          {slot.d}
                        </span>
                        {holiday && <span className="text-[10px] text-rose-500 truncate">{shortHolidayName(holiday)}</span>}
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
                        const inSel = selRange && selRange.row === row.key && col.iso >= selRange.from && col.iso <= selRange.to;
                        const isFormTarget = !editing && form.projectId === row.key && col.iso >= form.start && col.iso <= form.end;
                        return (
                          <div key={col.iso} data-iso={col.iso} data-row={row.key}
                            onPointerDown={(ev) => beginDrag(ev, "select", row.key, col.iso, null)}
                            className={"min-h-[30px] py-1 flex flex-col gap-[2px] cursor-pointer border-r border-gray-50 last:border-r-0 " +
                              (inSel ? "bg-sky-100/70 " : isFormTarget ? "bg-sky-50 " : isToday ? "bg-amber-50/50 " : "hover:bg-gray-50 ") +
                              (inMonth ? "" : "opacity-50")}>
                            {col.lanes.map((seg, li) => {
                              if (!seg) return <div key={li} className="h-[18px]" />;
                              const e = seg.e;
                              const round = (seg.isStart ? "rounded-l ml-1 " : "") + (seg.isEnd ? "rounded-r mr-1" : "");
                              const showLabel = seg.isStart || ci === 0;
                              const isDragging = drag?.moved && drag.ev?.id === e.id;
                              const isEditing = form.id === e.id;
                              const tip = e.title + (e.assignee ? ` · ${e.assignee}` : "") +
                                (e.event_date !== e.end_date ? ` (${fmtMD(e.event_date)}~${fmtMD(e.end_date)})` : "");
                              return (
                                <div key={li} title={tip}
                                  onPointerDown={(ev) => beginDrag(ev, "move", row.key, col.iso, e)}
                                  className={`group/bar relative h-[18px] leading-[18px] text-[11px] px-1 truncate cursor-grab ${chipClass(e)} ${round} ` +
                                    (e.is_done ? "line-through " : "") +
                                    (isDragging ? "opacity-70 shadow " : "hover:brightness-95 ") +
                                    (isEditing ? "ring-2 ring-amber-400 " : "")}>
                                  {showLabel ? e.title : " "}
                                  {seg.isStart && (
                                    <span onPointerDown={(ev) => beginDrag(ev, "resize-start", row.key, col.iso, e)}
                                      className="absolute left-0 top-0 h-full w-1.5 cursor-ew-resize opacity-0 group-hover/bar:opacity-100 bg-black/20 rounded-l" />
                                  )}
                                  {seg.isEnd && (
                                    <span onPointerDown={(ev) => beginDrag(ev, "resize-end", row.key, col.iso, e)}
                                      className="absolute right-0 top-0 h-full w-1.5 cursor-ew-resize opacity-0 group-hover/bar:opacity-100 bg-black/20 rounded-r" />
                                  )}
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
        <div className="mt-2 text-[11px] text-gray-400">
          칸 클릭=날짜 지정 · 칸 끌기=기간 지정 · 일정 클릭=수정 · 일정 끌기=이동(다른 프로젝트 행으로도) · 일정 양 끝 끌기=기간 조절
        </div>
      </div>
    </div>
  );
}
