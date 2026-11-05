"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { supabase } from "@/lib/supabase";
import { styles } from "@/common/styles";
import {
  CAUTION_OPTIONS, SEASON_NOTE_MAX, SEASON_OPTIONS, WASH_OPTIONS,
  normalizeDetailOptions, type DetailOptions,
} from "@/lib/detailOptions";

// MD기능 [멘트] — 마이그 195 기준 단순 메모 + 자동 prefill.
//   - tenant 가 starter text 정의 → 신규 작성 시 자동 prefill (= form 자동입력).
//   - 사용자는 textarea 에서 자유 편집. 라벨 / 폼 강제 X.
//   - 나중에 AI 프롬프트로 그대로 전달 (text 1 덩어리).
//   - "양식 편집" 토글로 tenant 의 starter text 직접 수정.
//   - 입력을 멈추면 자동 저장. 창을 닫거나 다음 상품으로 넘어갈 때 남은 변경도 저장.
// 박제: products.comment_data TEXT + tenants.comment_template TEXT.

const AUTOSAVE_DELAY_MS = 800;

type Props = {
  tenantId: string;
  productId: string;
  autoFocus: boolean;
  onSaved: (productId: string) => void;
};

type SaveState = "idle" | "saving" | "saved" | "error";

// 195 적용 전엔 DB가 JSONB (array/object). 적용 후엔 TEXT. 둘 다 안전 변환.
// JSONB array of labels  → "label:\n..." (template starter 형식)
// JSONB object {k: v}    → "k: v\n..."  (메모 형식)
function safeText(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v;
  if (Array.isArray(v)) {
    return v.filter(Boolean).map(String).map(s => s + ":").join("\n");
  }
  if (typeof v === "object") {
    return Object.entries(v as Record<string, unknown>)
      .map(([k, val]) => `${k}: ${val ?? ""}`).join("\n");
  }
  return String(v);
}

// 양식을 그대로 둔 메모는 빈 값 — 안 그러면 "원단:" 같은 빈 줄이 상세페이지 맨 위에 나감.
function toUpdate(memo: string, options: DetailOptions, template: string) {
  const untouched = !!template.trim() && memo.trim() === template.trim();
  return {
    comment_data: untouched ? "" : memo,
    detail_options: { ...options, season_note: options.season_note.trim() },
    updated_at: new Date().toISOString(),
  };
}

// 상세페이지 선택 항목 — 여러 개 선택 가능한 칩 묶음.
function OptionChips({ title, options, selected, onChange }: {
  title: string;
  options: { key: string; label: string }[];
  selected: string[];
  onChange: (next: string[]) => void;
}) {
  return (
    <div>
      <p className="text-xs font-bold text-black mb-1.5">{title}</p>
      <div className="flex flex-wrap gap-1.5">
        {options.map(o => {
          const on = selected.includes(o.key);
          return (
            <button key={o.key} type="button" aria-pressed={on}
              onClick={() => onChange(on ? selected.filter(k => k !== o.key) : [...selected, o.key])}
              className={"px-3 py-1.5 text-xs rounded border " + (on ? "bg-black text-white border-black font-medium" : "bg-white text-gray-700 border-gray-300 hover:border-gray-500")}>
              {o.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

export default function CommentSection({ tenantId, productId, autoFocus, onSaved }: Props) {
  const [loading, setLoading] = useState(true);
  const [template, setTemplate] = useState("");
  const [memo, setMemo] = useState("");
  const [options, setOptions] = useState<DetailOptions>(() => normalizeDetailOptions(null));
  const [editMode, setEditMode] = useState(false);
  const [draftTemplate, setDraftTemplate] = useState("");
  const [templateSaving, setTemplateSaving] = useState(false);
  const [saveState, setSaveState] = useState<SaveState>("idle");

  // 자동 저장은 타이머·화면 해제 시점에 돌아가므로 최신 입력값을 ref 로 읽음.
  const latest = useRef({ memo: "", options: normalizeDetailOptions(null), template: "" });
  const dirty = useRef(false);
  const inFlight = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onSavedRef = useRef(onSaved);
  const memoRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { onSavedRef.current = onSaved; });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [{ data: tenant }, { data: product }] = await Promise.all([
        supabase.from("tenants").select("comment_template").eq("id", tenantId).maybeSingle(),
        supabase.from("products").select("comment_data, detail_options").eq("id", productId).maybeSingle(),
      ]);
      if (cancelled) return;
      // DB 상태 무관 (JSONB / TEXT 둘 다) 안전 변환
      const tpl = safeText(tenant?.comment_template);
      const data = safeText(product?.comment_data);
      const initialOptions = normalizeDetailOptions(product?.detail_options);
      // 빈 메모 + 양식 있으면 자동 prefill (= 양식 그대로 시작)
      const initialMemo = data || tpl;
      latest.current = { memo: initialMemo, options: initialOptions, template: tpl };
      setTemplate(tpl);
      setDraftTemplate(tpl);
      setMemo(initialMemo);
      setOptions(initialOptions);
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [tenantId, productId]);

  useEffect(() => {
    if (!loading && autoFocus) memoRef.current?.focus();
  }, [loading, autoFocus]);

  const flush = useCallback(async () => {
    if (timer.current) { clearTimeout(timer.current); timer.current = null; }
    if (!dirty.current || inFlight.current) return;
    inFlight.current = true;
    setSaveState("saving");
    // 저장 중에 또 입력하면 끝난 뒤 이어서 저장
    while (dirty.current) {
      dirty.current = false;
      const { memo: m, options: o, template: t } = latest.current;
      const { error } = await supabase.from("products").update(toUpdate(m, o, t)).eq("id", productId);
      if (error) {
        dirty.current = true;
        inFlight.current = false;
        setSaveState("error");
        return;
      }
      onSavedRef.current(productId);
    }
    inFlight.current = false;
    setSaveState("saved");
  }, [productId]);

  function scheduleSave() {
    dirty.current = true;
    setSaveState("saving");
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(flush, AUTOSAVE_DELAY_MS);
  }

  // 창을 닫거나 다음 상품으로 넘어갈 때 아직 저장되지 않은 입력을 저장.
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
    if (!dirty.current) return;
    dirty.current = false;
    const { memo: m, options: o, template: t } = latest.current;
    void (async () => {
      const { error } = await supabase.from("products").update(toUpdate(m, o, t)).eq("id", productId);
      if (error) alert(`멘트 저장 실패: ${error.message}`);
      else onSavedRef.current(productId);
    })();
  }, [productId]);

  function changeMemo(next: string) {
    latest.current = { ...latest.current, memo: next };
    setMemo(next);
    scheduleSave();
  }

  function changeOptions(next: DetailOptions) {
    latest.current = { ...latest.current, options: next };
    setOptions(next);
    scheduleSave();
  }

  async function handleSaveTemplate() {
    setTemplateSaving(true);
    const { error } = await supabase.from("tenants")
      .update({ comment_template: draftTemplate })
      .eq("id", tenantId);
    setTemplateSaving(false);
    if (error) { alert(`양식 저장 실패: ${error.message}`); return; }
    latest.current = { ...latest.current, template: draftTemplate };
    setTemplate(draftTemplate);
    setEditMode(false);
  }

  function resetToTemplate() {
    if (!template) return;
    if (memo.trim() && !confirm("현재 메모를 양식으로 덮어씁니다. 진행할까요?")) return;
    changeMemo(template);
  }

  const statusText = saveState === "saving" ? "저장 중…"
    : saveState === "saved" ? "저장됨"
    : saveState === "error" ? "저장 실패 — 내용을 다시 수정하면 재시도합니다"
    : "";

  return (
    <section className="space-y-3">
      <div className="flex items-center gap-2">
        <h4 className="text-sm font-bold text-black">멘트</h4>
        <span role="status" className={"text-[11px] " + (saveState === "error" ? "text-red-600" : "text-gray-500")}>{statusText}</span>
        <button type="button" onClick={() => setEditMode(!editMode)}
          className="ml-auto text-xs text-gray-500 hover:text-black underline whitespace-nowrap">
          {editMode ? "← 메모 입력" : "양식 편집"}
        </button>
      </div>

      {loading ? (
        <p className="text-xs text-gray-400 text-center py-6">불러오는 중...</p>
      ) : editMode ? (
        <>
          <p className="text-xs text-gray-500">
            새 멘트 작성 시 이 양식이 자동으로 채워집니다. 예시: <code className="bg-gray-100 px-1 rounded">원단:\n착용감:\n계절감:</code>
          </p>
          <textarea value={draftTemplate} onChange={e => setDraftTemplate(e.target.value)}
            rows={8}
            placeholder="원단:&#10;착용감:&#10;계절감:&#10;"
            className={styles.modalInput + " resize-none font-mono text-xs leading-relaxed"} />
          <div className="flex justify-end">
            <button type="button" onClick={handleSaveTemplate} disabled={templateSaving} className={styles.btnPrimary}>
              {templateSaving ? "저장 중..." : "양식 저장"}
            </button>
          </div>
        </>
      ) : (
        <>
          <div className="relative">
            <textarea ref={memoRef} value={memo} onChange={e => changeMemo(e.target.value)}
              rows={8}
              aria-label="메모"
              placeholder={template || "양식이 없습니다. 우상단 '양식 편집' 으로 starter text 를 설정해보세요."}
              className={styles.modalInput + " resize-y text-sm leading-relaxed"} />
            {template && (
              <button type="button" onClick={resetToTemplate}
                className="absolute right-3 bottom-3 text-[11px] text-gray-500 hover:text-black underline bg-white/80 px-1">
                양식으로 초기화
              </button>
            )}
          </div>
          <div className="space-y-3">
            <OptionChips title="계절감" options={SEASON_OPTIONS} selected={options.seasons}
              onChange={seasons => changeOptions({ ...options, seasons })} />
            <input type="text" value={options.season_note} maxLength={SEASON_NOTE_MAX}
              onChange={e => changeOptions({ ...options, season_note: e.target.value })}
              placeholder="계절감 한 줄 문구 (선택) 예: 도톰하고 포근한 두께감"
              aria-label="계절감 한 줄 문구"
              className={styles.modalInput + " text-sm text-black"} />
            <OptionChips title="세탁방법" options={WASH_OPTIONS} selected={options.washes}
              onChange={washes => changeOptions({ ...options, washes })} />
            <OptionChips title="주의사항" options={CAUTION_OPTIONS} selected={options.cautions}
              onChange={cautions => changeOptions({ ...options, cautions })} />
          </div>
        </>
      )}
    </section>
  );
}
