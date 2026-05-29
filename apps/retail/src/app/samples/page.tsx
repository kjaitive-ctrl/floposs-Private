"use client";

import { useEffect, useRef, useState, KeyboardEvent, ChangeEvent } from "react";
import { supabase } from "@/lib/supabase";
import { styles } from "@/common/styles";
import { useTenant } from "@/lib/TenantContext";
import {
  cartesian, emptyRow, joinUniq, materialToText, newKey, split, textToMaterial,
  vKeyCombo, vKeyVar,
  type DbProduct, type EditableRow, type Variant,
} from "@/lib/samplesUtils";
import { formatComma, formatShortDate, parseDigits, parseShortDate } from "@/lib/format";
import SizeModal from "@/components/SizeModal";
import MemoModal from "@/components/MemoModal";
import HelpDot from "@/components/HelpDot";
import SaveStatusDot from "@/components/SaveStatusDot";
import Pagination from "@/components/Pagination";
import ProductsToolbar, { type SearchCol } from "@/components/ProductsToolbar";
import { useCellNavigation } from "@/lib/useCellNavigation";
import { useRowAutosave } from "@/lib/useRowAutosave";
import { useCategoryOptions } from "@/lib/useCategoryOptions";
// excelUtils 는 dynamic import — xlsx 라이브러리 (~500KB) 가 버튼 클릭 시점에만 로드


// 짧은 날짜 input — 표시 "26-06-03", 박제는 ISO "2026-06-03".
// 입력 중에는 raw 만 유지. 셀 떠날 때(blur) parseShortDate → 부모 onChange.
// Enter/↑↓ 키도 focus 이동 전에 명시 parsing (blur timing 불안정 회피).
// 잘못된 입력은 raw 를 원래 ISO 값으로 복원.
function ShortDateInput({
  isoValue, onChange, id, onKeyDown, className, readOnly,
}: {
  isoValue: string;
  onChange: (iso: string) => void;
  id?: string;
  onKeyDown?: (e: KeyboardEvent<HTMLInputElement>) => void;
  className?: string;
  readOnly?: boolean;
}) {
  // 외부 ISO 변경 시 raw 동기화 (자동 박제 / fetchItems / UPDATE 후).
  // React 권장 패턴 — derived state 는 render 중 prev 비교 후 setState (effect 안 setState 회피).
  const [raw, setRaw] = useState(formatShortDate(isoValue));
  const [prevIso, setPrevIso] = useState(isoValue);
  if (isoValue !== prevIso) {
    setPrevIso(isoValue);
    setRaw(formatShortDate(isoValue));
  }

  function commitRaw() {
    if (readOnly) return;
    const cleaned = raw.replace(/[^0-9]/g, "");
    if (cleaned === "") {
      onChange("");
      setRaw("");
      return;
    }
    const parsed = parseShortDate(raw);
    if (parsed) {
      onChange(parsed);
      setRaw(formatShortDate(parsed)); // useEffect 기다리지 않고 즉시 raw 갱신
    } else {
      setRaw(formatShortDate(isoValue));
    }
  }

  function handleKey(e: KeyboardEvent<HTMLInputElement>) {
    // Enter / Shift+Enter / ↑↓ 시 focus 이동 전 명시 parsing
    if (!readOnly && (e.key === "Enter" || e.key === "ArrowUp" || e.key === "ArrowDown")) {
      commitRaw();
    }
    onKeyDown?.(e);
  }

  return (
    <input id={id} type="text" inputMode="numeric"
      value={raw}
      onChange={e => setRaw(e.target.value)}
      onBlur={commitRaw}
      onKeyDown={handleKey}
      readOnly={readOnly}
      placeholder={readOnly ? "" : "연-월-일"} maxLength={8}
      className={className} />
  );
}

export default function SamplesPage() {
  const { tenant, loading: tenantLoading, error: tenantError } = useTenant();
  const [rows, setRows] = useState<EditableRow[]>([emptyRow()]);
  const [variantsMap, setVariantsMap] = useState<Record<string, Variant[]>>({});
  const [loading, setLoading] = useState(true);
  const [sizeModalRow, setSizeModalRow] = useState<EditableRow | null>(null);
  const [memoModalRow, setMemoModalRow] = useState<EditableRow | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [uploading, setUploading] = useState(false);

  // ── 검색/필터/페이지네이션 ──
  // applied = Enter 시점에 commit 된 값. fetchItems 의존성. searchCol 변경만으론 fetch 안 함 (다음 Enter 까지 유효 입력).
  const [searchCol, setSearchCol] = useState<SearchCol>("wholesale_name");
  const [appliedSearch, setAppliedSearch] = useState("");
  const [category, setCategory] = useState("");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [total, setTotal] = useState(0);
  // 반납완료(status='returned') 숨김 토글 — 기본 ON. OFF 시 30일 cutoff 로직 적용.
  const [hideReturned, setHideReturned] = useState(true);
  const categoryOptions = useCategoryOptions(tenant?.id);
  // 사이즈 측정 카테고리 dropdown (measurement_templates 시스템 + tenant 커스텀)
  // /products 와 동일 — samples 에서 미리 선택해두면 [진행] 시 그대로 넘어감.
  const [measureCategories, setMeasureCategories] = useState<string[]>([]);

  async function handleDownloadTemplate() {
    const { downloadUploadTemplate } = await import("@/lib/excelUtils");
    downloadUploadTemplate();
  }

  async function handleUploadFile(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = ""; // 같은 파일 재선택 가능하게
    if (!file || !tenant?.id) return;
    if (!confirm(`"${file.name}" 파일의 상품을 일괄 등록하시겠습니까?`)) return;
    setUploading(true);
    try {
      const { parseUploadFile, batchInsertProducts } = await import("@/lib/excelUtils");
      const rows = await parseUploadFile(file);
      const result = await batchInsertProducts(tenant.id, rows);
      const msg = `등록 ${result.success}건 / 실패 ${result.failed}건` +
        (result.errors.length ? `\n\n[오류 ${result.errors.length}건]\n${result.errors.slice(0, 5).join("\n")}` : "");
      alert(msg);
      // 새 row 들이 page=1 에 prepend 됨 — 사장이 어디 갔는지 자연스럽게 보이도록 1페이지로 reset.
      if (page === 1) fetchItems(tenant.id); else setPage(1);
    } catch (err) {
      alert(`업로드 실패: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setUploading(false);
    }
  }

  // saveRow callback 안에서 항상 최신 rows/variantsMap 참조 — render 후 effect 에서 ref 갱신.
  // (render 중 ref 갱신은 react-hooks/refs 룰 위반. user action/setTimeout 시점엔 effect 완료 후라 안전.)
  const rowsRef = useRef(rows);
  const variantsRef = useRef(variantsMap);
  useEffect(() => { rowsRef.current = rows; });
  useEffect(() => { variantsRef.current = variantsMap; });

  // 자동저장 hook — saveRow 가 INSERT/UPDATE 분기 + variants compare-and-update.
  // hook 이 timers/inFlight/dirtyAgain + setSaveStatus 관리. Enter 트리거는 runSave 직접 호출.
  const { saveState, setSaveStatus, scheduleAutosave, runSave } = useRowAutosave({
    saveRow: async (rowKey) => {
      if (!tenant?.id) return { ok: false };
      const row = rowsRef.current.find(r => r._key === rowKey);
      if (!row) return { ok: false };

      const o1 = split(row.option1);
      const o2 = split(row.option2);
      const o3 = split(row.option3);

      if (!row.id) {
        // ─────────── INSERT ───────────
        // wholesale_name 빈값이면 호출부에서 차단 (Enter 트리거 가드). 여기 도달 시 값 있음 보장.
        const { count } = await supabase.from("products")
          .select("*", { count: "exact", head: true })
          .eq("tenant_id", tenant.id);
        const productCode = `R-${String((count ?? 0) + 1).padStart(3, "0")}`;

        // 등록 시 자동 박제: 입고일=KST 오늘, 반납기한=입고일+14일.
        const kstToday = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Seoul" });
        const launchDate = row.launch_date || kstToday;
        const deadlineDate = row.return_deadline || (() => {
          const d = new Date(launchDate);
          d.setDate(d.getDate() + 14);
          return d.toISOString().slice(0, 10);
        })();

        const { data, error } = await supabase.from("products").insert({
          tenant_id: tenant.id,
          product_code: productCode,
          name: row.wholesale_name.trim(),
          wholesale_name: row.wholesale_name.trim(),
          wholesale_supplier: row.wholesale_supplier.trim() || null,
          category: row.category.trim() || null,
          wholesale_price: row.wholesale_price ? Number(row.wholesale_price) : null,
          wholesale_discount_price: row.wholesale_discount_price ? Number(row.wholesale_discount_price) : null,
          launch_date: launchDate,
          return_deadline: deadlineDate,
          return_shipped_date: row.return_shipped_date || null,
          status: row.status,
          description: row.description.trim() || null,
          country_of_origin: row.country_of_origin.trim() || null,
          material_composition: textToMaterial(row.material_composition),
          option1_label: o1.length > 0 ? "색상" : null,
          option2_label: o2.length > 0 ? "사이즈" : null,
          option3_label: null,
          is_active: true,
        }).select("id, product_code").single();

        if (error || !data) {
          console.error("INSERT failed:", error);
          return { ok: false };
        }

        // 1) 방금 INSERT 한 row 에 id/product_code + 자동 박제값 반영
        // 2) 새 빈 draft 를 표 최상단 prepend
        // 3) 새 draft 의 도매상품명 셀로 focus 이동
        const newDraft = emptyRow();
        setRows(prev => {
          const updated = prev.map(r =>
            r._key === rowKey ? {
              ...r,
              id: data.id,
              product_code: data.product_code ?? "",
              launch_date: launchDate,
              return_deadline: deadlineDate,
            } : r
          );
          return [newDraft, ...updated];
        });
        setTotal(t => t + 1); // 페이지네이션 푸터 카운트 즉시 반영 (다음 fetch 까지)
        setTimeout(() => {
          document.getElementById(`cell-${newDraft._key}-wholesale_name`)?.focus();
        }, 50);

        // variants INSERT — sort_order 명시 박제 (마이그 033 정공법, 1ms hack 폐기)
        const combos = cartesian(o1, o2, o3);
        if (combos.length > 0) {
          const { data: vData } = await supabase.from("product_variants").insert(
            combos.map((c, i) => ({
              product_id: data.id,
              color: c.o1 || null,
              size: c.o2 || null,
              option3: c.o3 || null,
              sort_order: i + 1,
            }))
          ).select("id, color, size, option3, sort_order");
          if (vData) {
            setVariantsMap(m => ({ ...m, [data.id]: vData as Variant[] }));
          }
        } else {
          setVariantsMap(m => ({ ...m, [data.id]: [] }));
        }

        return { ok: true };
      }

      // ─────────── UPDATE ───────────
      const { error } = await supabase.from("products").update({
        wholesale_name: row.wholesale_name.trim() || null,
        wholesale_supplier: row.wholesale_supplier.trim() || null,
        category: row.category.trim() || null,
        wholesale_price: row.wholesale_price ? Number(row.wholesale_price) : null,
        wholesale_discount_price: row.wholesale_discount_price ? Number(row.wholesale_discount_price) : null,
        launch_date: row.launch_date || null,
        return_deadline: row.return_deadline || null,
        return_shipped_date: row.return_shipped_date || null,
        status: row.status,
        description: row.description.trim() || null,
        country_of_origin: row.country_of_origin.trim() || null,
        material_composition: textToMaterial(row.material_composition),
        option1_label: o1.length > 0 ? "색상" : null,
        option2_label: o2.length > 0 ? "사이즈" : null,
        updated_at: new Date().toISOString(),
      }).eq("id", row.id);

      if (error) {
        console.error("UPDATE failed:", error);
        return { ok: false };
      }

      // ─────────── variants compare-and-update ───────────
      const newCombos = cartesian(o1, o2, o3);
      const newKeys = new Set(newCombos.map(vKeyCombo));
      const oldVariants = variantsRef.current[row.id] ?? [];
      const oldKeys = new Set(oldVariants.map(vKeyVar));

      const toInsert = newCombos.filter(c => !oldKeys.has(vKeyCombo(c)));
      const toDeactivate = oldVariants.filter(v => !newKeys.has(vKeyVar(v)) && v.id);

      if (toInsert.length > 0) {
        // sort_order 명시 — 기존 max(sort_order) + 1 부터 이어감
        const maxSort = Math.max(0, ...oldVariants.map(v => v.sort_order ?? 0));
        const { data: vData, error: vErr } = await supabase.from("product_variants").insert(
          toInsert.map((c, i) => ({
            product_id: row.id,
            color: c.o1 || null,
            size: c.o2 || null,
            option3: c.o3 || null,
            sort_order: maxSort + i + 1,
          }))
        ).select("id, color, size, option3, sort_order");
        if (vErr) {
          console.error("variants INSERT 실패:", vErr);
          alert(`옵션 저장 실패: ${vErr.message}\n(옛 inactive variants 와 UNIQUE 충돌 가능성 — SQL 로 정리 필요)`);
          return { ok: false };
        }
        if (vData) {
          setVariantsMap(m => ({
            ...m,
            [row.id!]: [...(m[row.id!] ?? []), ...(vData as Variant[])],
          }));
        }
      }
      if (toDeactivate.length > 0) {
        await supabase.from("product_variants")
          .update({ is_active: false })
          .in("id", toDeactivate.map(v => v.id!));
        setVariantsMap(m => ({
          ...m,
          [row.id!]: (m[row.id!] ?? []).filter(v => !toDeactivate.some(d => d.id === v.id)),
        }));
      }

      return { ok: true };
    },
  });

  async function fetchItems(tenantId: string) {
    setLoading(true);
    // /samples = 가등록(sample_*) + 정식 등록(registered) 모두 표시. inactive(품절) 만 항상 제외.
    // 반납완료 토글:
    //   ON(default)  → status != 'returned' 완전 제외
    //   OFF          → 반납 30일 후 자동 숨김 (status != returned) OR (shipped_date IS NULL) OR (>= 30일 전)
    const offset = (page - 1) * pageSize;
    let query = supabase
      .from("products")
      .select("id, product_code, wholesale_name, wholesale_supplier, category, wholesale_price, wholesale_discount_price, status, launch_date, return_deadline, return_shipped_date, description, country_of_origin, material_composition, product_variants(id, color, size, option3, is_active, consumer_label_color, consumer_label_size, consumer_label_option3, is_for_sale, sold_out, variant_code, sort_order)", { count: "exact" })
      .eq("tenant_id", tenantId)
      .eq("is_active", true)
      .neq("status", "inactive");
    if (hideReturned) {
      query = query.neq("status", "returned");
    } else {
      const cutoff = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
      query = query.or(`status.neq.returned,return_shipped_date.is.null,return_shipped_date.gte.${cutoff}`);
    }
    // 검색 — 단일 컬럼 ilike. ilike 안 % 는 사용자가 박을 수 없음 (자동 wrap).
    if (appliedSearch) query = query.ilike(searchCol, `%${appliedSearch}%`);
    if (category)      query = query.eq("category", category);
    const { data, count } = await query
      .order("created_at", { ascending: false })
      .range(offset, offset + pageSize - 1);
    const items = (data ?? []) as DbProduct[];
    setTotal(count ?? 0);
    const vMap: Record<string, Variant[]> = {};
    const editable: EditableRow[] = items.map(p => {
      // 마이그 033 — sort_order 정공법으로 정렬 통일 (joinUniq 결과 = chip 순)
      const active = (p.product_variants ?? [])
        .filter(v => v.is_active !== false)
        .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0));
      const vs = active.map(v => ({
        id: v.id, color: v.color, size: v.size, option3: v.option3,
        sort_order: (v as { sort_order?: number }).sort_order ?? 0,
      }));
      vMap[p.id] = vs;
      return {
        _key: newKey(),
        id: p.id,
        product_code: p.product_code ?? "",
        wholesale_name: p.wholesale_name ?? "",
        wholesale_supplier: p.wholesale_supplier ?? "",
        category: p.category ?? "",
        wholesale_price: p.wholesale_price?.toString() ?? "",
        wholesale_discount_price: p.wholesale_discount_price?.toString() ?? "",
        status: p.status ?? "sample_received",
        launch_date: p.launch_date ?? "",
        return_deadline: p.return_deadline ?? "",
        return_shipped_date: p.return_shipped_date ?? "",
        option1: joinUniq(vs, "color"),
        option2: joinUniq(vs, "size"),
        option3: joinUniq(vs, "option3"),
        description: p.description ?? "",
        country_of_origin: p.country_of_origin ?? "",
        material_composition: materialToText(p.material_composition),
        // /samples 에서 미노출. /products 에서 박제. fetchItems 빈값, UPDATE 시 박제 X → DB 값 유지.
        consumer_name: "",
        consumer_option1: "",
        consumer_option2: "",
        consumer_option3: "",
        progress_memo: "",
      };
    });
    setVariantsMap(vMap);
    // 빈 draft 는 page=1 일 때만 표 최상단 (등록 가능 시점). page>1 에선 fetched 만.
    setRows(page === 1 ? [emptyRow(), ...editable] : editable);
    setLoading(false);
  }

  useEffect(() => {
    if (tenant?.id) fetchItems(tenant.id);
    // fetchItems 는 page/pageSize/appliedSearch/searchCol/category state 를 closure 로 사용
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tenant?.id, page, pageSize, appliedSearch, searchCol, category, hideReturned]);

  // measurement_templates 카테고리 옵션 fetch — 행별 카테고리 dropdown 용
  useEffect(() => {
    if (!tenant?.id) return;
    supabase.from("measurement_templates")
      .select("category, sort_order, tenant_id")
      .or(`tenant_id.is.null,tenant_id.eq.${tenant.id}`)
      .eq("is_active", true)
      .order("sort_order", { ascending: true })
      .then(({ data }) => {
        const set = new Set<string>();
        (data ?? []).forEach((r: { category: string }) => set.add(r.category));
        setMeasureCategories(Array.from(set));
      });
  }, [tenant?.id]);

  async function updateSampleCategory(row: EditableRow, newCategory: string) {
    if ((row.category ?? "") === newCategory) return;
    if (!row.id) return; // draft row (아직 INSERT 전)
    setSaveStatus(row._key, "saving");
    const { error } = await supabase.from("products")
      .update({ category: newCategory || null, updated_at: new Date().toISOString() })
      .eq("id", row.id);
    if (error) {
      setSaveStatus(row._key, "error", true);
      alert(`카테고리 변경 실패: ${error.message}`);
      return;
    }
    setSaveStatus(row._key, "saved", true);
    setRows(prev => prev.map(r => r._key === row._key ? { ...r, category: newCategory } : r));
  }

  // ↑↓ 화살표 또는 Enter/Shift+Enter → 위/아래 row 의 같은 컬럼 셀로 focus 이동.
  // Tab/Shift+Tab 은 HTML 기본(좌/우) 유지.
  // 공급상품명 셀의 draft INSERT 트리거는 별도 — 호출 측에서 먼저 처리.
  // draft (id 없음) 으로 이동 시 같은 column 없으면 wholesale_name 으로 fallback.
  // 그래야 다른 컬럼에서 ↑ 눌렀을 때 등록 행 input 으로 이동.
  // 주의: hook 이므로 early return (tenantLoading/Error) 위에 둬야 Rules of Hooks 안 깨짐.
  const handleNav = useCellNavigation<EditableRow>({
    rowsRef,
    fallbackCol: (nextRow) => (nextRow.id ? null : "wholesale_name"),
  });

  function updateCell(rowKey: string, field: keyof EditableRow, value: string) {
    setRows(prev => {
      const idx = prev.findIndex(r => r._key === rowKey);
      if (idx < 0) return prev;
      const next = [...prev];
      next[idx] = { ...next[idx], [field]: value };
      return next;
    });
    // draft row (id 없음) 는 자동저장 X — Enter 트리거 시점에만 INSERT.
    const row = rowsRef.current.find(r => r._key === rowKey);
    if (!row?.id) return;
    scheduleAutosave(rowKey);
  }

  // draft 의 도매상품명 셀에서 Enter → 즉시 INSERT 트리거.
  // 옛 동작 보존: wholesale_name 빈값이면 발동 X (조용히 무시).
  function triggerDraftInsert(rowKey: string) {
    const row = rowsRef.current.find(r => r._key === rowKey);
    if (!row?.wholesale_name.trim()) return;
    runSave(rowKey);
  }

  // 진행 — 정식 상품으로 승격 (status='registered'). /samples 에서 사라지고 /products 에 등장.
  // 마이그 198: status 변경과 함께 바코드 자동 발급 (Product 18자리 + 활성 variants 22자리).
  async function handlePromote(rowKey: string) {
    const row = rowsRef.current.find(r => r._key === rowKey);
    if (!row?.id) return;
    if (!confirm("이 상품을 정식 상품으로 등록하시겠습니까? (상품 탭으로 이동, 바코드 자동 발급)")) return;

    setSaveStatus(rowKey, "saving");
    const { error } = await supabase.from("products")
      .update({ status: "registered", updated_at: new Date().toISOString() })
      .eq("id", row.id);

    if (error) {
      setSaveStatus(rowKey, "error");
      alert(`등록 실패: ${error.message}`);
      return;
    }

    // 바코드 발급 (RPC atomic — Product + 활성 variants 일괄)
    const { error: barcodeError } = await supabase.rpc("issue_product_barcode", {
      p_product_id: row.id,
    });
    if (barcodeError) {
      // 상품 등록은 성공했으니 경고만. UI 새로고침 시 재발급 시도 가능 (status 가드).
      console.error("바코드 발급 실패:", barcodeError);
      alert(`상품 등록은 완료됐지만 바코드 발급에 실패했습니다: ${barcodeError.message}\n새로고침 후 상품 탭에서 확인해주세요.`);
    }

    // /samples 에 그대로 표시 (같은 row 양쪽 탭 모두 표시). status 만 갱신.
    setRows(prev => prev.map(r => r._key === rowKey ? { ...r, status: "registered" } : r));
    setSaveStatus(rowKey, "saved", true);
  }

  async function handleDelete(rowKey: string) {
    const row = rowsRef.current.find(r => r._key === rowKey);
    if (!row) return;
    if (!row.id) {
      setRows(prev => prev.filter(r => r._key !== rowKey));
      return;
    }
    if (!confirm("이 샘플을 삭제하시겠습니까?")) return;
    await supabase.from("products").update({ is_active: false }).eq("id", row.id);
    setVariantsMap(m => {
      const n = { ...m };
      delete n[row.id!];
      return n;
    });
    // 삭제로 row 빠진 자리에 다음 페이지의 row 채우려면 재조회 (total 도 갱신)
    if (tenant?.id) fetchItems(tenant.id);
  }

  if (tenantLoading) {
    return <div className={styles.page}><main className="px-6 py-8 text-xs text-gray-400">불러오는 중...</main></div>;
  }
  if (tenantError || !tenant) {
    return <div className={styles.page}><main className="px-6 py-8 text-xs text-red-500">tenant 정보 조회 실패: {tenantError}</main></div>;
  }

  const th = "px-2 py-2 text-xs font-medium text-gray-600 border-r border-b border-gray-200 whitespace-nowrap bg-gray-100 sticky top-0 z-20 text-center";
  const td = "border-r border-gray-100 align-middle";
  // draft 행 (thead 2번째 줄, sticky) — 비활성 셀은 헤더와 같은 회색 (입력 셀만 강조)
  const tdDraft = "border-r border-gray-100 align-middle bg-gray-100 sticky top-8 z-10";
  // 공급상품명 입력 셀 전용 — 회색 행 위에 흰색 박스 + 검은 border 로 "여기에 입력" 강조
  const inpDraftActive = "w-full px-2 py-1 text-xs font-medium bg-white text-black placeholder:text-gray-500 border border-black rounded focus:outline-none focus:ring-1 focus:ring-black focus:ring-inset";
  const inp = "w-full px-2 py-1.5 text-xs bg-transparent text-black placeholder:text-gray-500 focus:outline-none focus:bg-white focus:ring-1 focus:ring-black focus:ring-inset";
  // date input 전용 — 빈 value 시 placeholder 글씨(연도-월-일) 옅은 회색, 채워지면 검은색
  const inpDate = "w-full px-2 py-1.5 text-xs bg-transparent placeholder:text-gray-500 focus:outline-none focus:bg-white focus:ring-1 focus:ring-black focus:ring-inset";
  const dateColor = (v: string) => v ? " text-black" : " text-gray-400";

  // 반납기한 셀 배경 — KST 기준 잔여 일수.
  // 실제반납 채워졌으면 평소. 경과=연한 빨강. 0~3일 임박=연한 주황.
  function deadlineCellBg(row: EditableRow): string {
    if (!row.return_deadline || row.return_shipped_date) return "";
    const kstToday = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Seoul" });
    const days = Math.floor((Date.parse(row.return_deadline) - Date.parse(kstToday)) / 86400000);
    if (days < 0)  return "bg-red-100";
    if (days <= 3) return "bg-orange-100";
    return "";
  }

  // 셀 공통 props — id/value/onChange/onKeyDown 한 헬퍼로 묶음.
  // 도매상품명 셀처럼 onKeyDown override 필요한 경우 spread 뒤에 onKeyDown 다시 박으면 됨.
  function cellProps<K extends keyof EditableRow>(row: EditableRow, col: K) {
    const colStr = String(col);
    return {
      id: `cell-${row._key}-${colStr}`,
      value: String(row[col] ?? ""),
      onChange: (e: ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
        updateCell(row._key, col, e.target.value),
      onKeyDown: (e: KeyboardEvent<HTMLInputElement | HTMLSelectElement>) =>
        handleNav(e, row._key, colStr),
    };
  }


  return (
    // NavBar 높이(h-12 + border-b 1px = 49px) 만큼 빼서 표 영역만 스크롤 분리
    <div className="flex flex-col bg-white" style={{ height: "calc(100vh - 49px)" }}>
      <header className={styles.header}>
        <ProductsToolbar
          searchCol={searchCol}
          onSearchColChange={setSearchCol}
          searchValue={appliedSearch}
          onSearchSubmit={v => { setAppliedSearch(v); setPage(1); }}
          category={category}
          onCategoryChange={v => { setCategory(v); setPage(1); }}
          categoryOptions={categoryOptions}
          pageSize={pageSize}
          onPageSizeChange={n => { setPageSize(n); setPage(1); }}
          rightActions={<>
            <label className="flex items-center gap-1.5 text-xs text-gray-600 cursor-pointer select-none">
              <input type="checkbox" checked={hideReturned}
                onChange={e => { setHideReturned(e.target.checked); setPage(1); }}
                className="w-4 h-4 accent-primary" />
              반납완료 숨기기
            </label>
            <button onClick={handleDownloadTemplate} className={styles.btnSmallGhost + " py-1"}>
              양식 다운로드
            </button>
            <button onClick={() => fileInputRef.current?.click()} disabled={uploading}
              className={styles.btnSmall + " py-1 disabled:opacity-50"}>
              {uploading ? "업로드 중…" : "일괄 업로드"}
            </button>
            <input ref={fileInputRef} type="file" accept=".xlsx,.xls,.csv"
              onChange={handleUploadFile} className="hidden" />
            <HelpDot>공급상품명 Enter = 등록 · ↑↓ / Shift+Enter 위아래 · Tab 좌우</HelpDot>
          </>}
        />
      </header>

      <main className="flex-1 overflow-hidden min-h-0 flex flex-col">
        {/* 박스가 main 전체 차지 + 내부 scroll — thead sticky가 header 바로 아래에 stick */}
        <div className="flex-1 overflow-auto bg-white">
          <table className="min-w-full" style={{ borderCollapse: "separate", borderSpacing: 0 }}>
            <thead className="border-b-2 border-gray-300 bg-gray-100 shadow">
              <tr className="text-left">
                <th className={th + " w-6 text-center"}></th>
                <th className={th + " min-w-[140px]"}>메모</th>
                <th className={th + " w-24"}>입고일</th>
                <th className={th + " w-24"}>반납기한</th>
                <th className={th + " w-24"}>실제반납</th>
                <th className={th + " w-24"}>
                  <span className="inline-flex items-center gap-1">
                    등록
                    <HelpDot><b>진행</b>: 상품을 판매하기 위해 &quot;진행&quot;처리합니다.</HelpDot>
                  </span>
                </th>
                <th className={th + " min-w-[160px]"}>
                  <span className="inline-flex items-center gap-1">
                    공급상품명
                    <HelpDot>상품명 입력 후 Enter를 통해 등록하실 수 있습니다. 그 이후 정보를 입력해주세요.</HelpDot>
                  </span>
                </th>
                <th className={th + " min-w-[130px]"}>옵션1 (색상)</th>
                <th className={th + " min-w-[130px]"}>옵션2 (사이즈)</th>
                <th className={th + " min-w-[110px]"}>옵션3</th>
                <th className={th + " w-32"}>공급가</th>
                <th className={th + " w-32"}>할인가</th>
                <th className={th + " w-20"}>제조국</th>
                <th className={th + " min-w-[140px]"}>혼용율</th>
                <th className={th + " min-w-[120px]"}>공급사</th>
                <th className={th + " w-32"}>카테고리</th>
                <th className={th + " w-10 text-center border-r-0"}>×</th>
              </tr>
              {/* thead 2번째 행 — draft 입력 행 (노란 음영, sticky). 항상 표 최상단 고정, × 없음 (삭제 불가).
                  rows[0] 는 항상 빈 draft (초기/INSERT 후 새 prepend 로 유지). 도매상품명 Enter = INSERT. */}
              {rows[0] && !rows[0].id && (
                <tr>
                  <td className={tdDraft + " w-6 text-center"}><SaveStatusDot status={saveState[rows[0]._key]} hideWhenIdle /></td>
                  {/* 좌측 빈 5칸 병합 → 셀 이동 가이드. draft row 가 thead 안이라 헤더 높이 증가 X. */}
                  <td className={tdDraft + " text-right pr-3"} colSpan={5}>
                    <span className="inline-flex items-center gap-2 text-[11px] text-gray-500">
                      <span>상하 <kbd className="px-1 py-0.5 bg-white border border-gray-200 rounded text-[10px]">↑</kbd> <kbd className="px-1 py-0.5 bg-white border border-gray-200 rounded text-[10px]">↓</kbd> <kbd className="px-1 py-0.5 bg-white border border-gray-200 rounded text-[10px]">Enter</kbd></span>
                      <span>좌우 <kbd className="px-1 py-0.5 bg-white border border-gray-200 rounded text-[10px]">Tab</kbd> <kbd className="px-1 py-0.5 bg-white border border-gray-200 rounded text-[10px]">⇧Tab</kbd></span>
                    </span>
                  </td>
                  <td className={tdDraft + " min-w-[160px] px-1 py-0.5"}>
                    <input
                      id={`cell-${rows[0]._key}-wholesale_name`}
                      value={rows[0].wholesale_name}
                      onChange={e => updateCell(rows[0]._key, "wholesale_name", e.target.value)}
                      onKeyDown={e => {
                        if (e.key === "Enter" && !e.shiftKey) {
                          e.preventDefault();
                          triggerDraftInsert(rows[0]._key);
                          return;
                        }
                        handleNav(e, rows[0]._key, "wholesale_name");
                      }}
                      placeholder="공급상품명 (Enter로 등록)"
                      className={inpDraftActive}
                    />
                  </td>
                  <td className={tdDraft + " min-w-[130px]"}></td>
                  <td className={tdDraft + " min-w-[130px]"}></td>
                  <td className={tdDraft + " min-w-[110px]"}></td>
                  <td className={tdDraft + " w-32"}></td>
                  <td className={tdDraft + " w-32"}></td>
                  <td className={tdDraft + " w-20"}></td>
                  <td className={tdDraft + " min-w-[140px]"}></td>
                  <td className={tdDraft + " min-w-[120px]"}></td>
                  <td className={tdDraft + " w-32"}></td>
                  <td className={tdDraft + " w-10 border-r-0"}></td>
                </tr>
              )}
            </thead>
            <tbody>
              {loading ? (
                <tr><td colSpan={16} className="px-3 py-6 text-center text-xs text-gray-600">불러오는 중...</td></tr>
              ) : (rows[0] && !rows[0].id ? rows.slice(1) : rows).map(row => {
                // /samples [진행] = wholesale [처리] 와 같은 박제 완료 액션.
                // status='registered' 이후엔 /samples 측 수정 잠금. 수정은 /products 에서.
                const isReg = row.status === "registered";
                const lockTxt = isReg ? " text-gray-400 bg-gray-50 cursor-not-allowed" : "";
                return (
                  <tr key={row._key} className="border-b border-gray-100 hover:bg-gray-50/40">
                    <td className={td + " text-center"}><SaveStatusDot status={saveState[row._key]} /></td>
                    {/* 메모(description): 클릭 시 MemoModal 열림. 줄바꿈 박제 가능. registered 후에도 편집 가능 */}
                    <td className={td}>
                      <div onClick={() => setMemoModalRow(row)}
                        className="px-2 py-1.5 text-xs cursor-pointer hover:bg-gray-50 truncate max-w-[140px]">
                        {row.description || <span className="text-gray-400">메모 (클릭)</span>}
                      </div>
                    </td>
                    <td className={td}>
                      <ShortDateInput
                        id={`cell-${row._key}-launch_date`}
                        isoValue={row.launch_date}
                        onChange={iso => updateCell(row._key, "launch_date", iso)}
                        onKeyDown={e => handleNav(e, row._key, "launch_date")}
                        className={inpDate + dateColor(row.launch_date)} />
                    </td>
                    <td className={td + " " + deadlineCellBg(row)}>
                      <ShortDateInput
                        id={`cell-${row._key}-return_deadline`}
                        isoValue={row.return_deadline}
                        onChange={iso => updateCell(row._key, "return_deadline", iso)}
                        onKeyDown={e => handleNav(e, row._key, "return_deadline")}
                        className={inpDate + dateColor(row.return_deadline)} />
                    </td>
                    <td className={td}>
                      <ShortDateInput
                        id={`cell-${row._key}-return_shipped_date`}
                        isoValue={row.return_shipped_date}
                        onChange={iso => updateCell(row._key, "return_shipped_date", iso)}
                        onKeyDown={e => handleNav(e, row._key, "return_shipped_date")}
                        className={inpDate + dateColor(row.return_shipped_date)} />
                    </td>
                    <td className={td + " text-center"}>
                      <div className="flex gap-1 justify-center">
                        {isReg ? (
                          <button disabled
                            title="등록된 상품의 사이즈 수정은 상품 탭에서 (예정)"
                            className={styles.btnSmallGhost + " text-gray-400 cursor-not-allowed"}>
                            SIZE
                          </button>
                        ) : (
                          <button onClick={() => setSizeModalRow(row)} className={styles.btnSmall}>
                            SIZE
                          </button>
                        )}
                        {isReg ? (
                          <button disabled
                            title="이미 정식 상품으로 등록됨 (상품 탭에서 [샘플로] 클릭 시 되돌릴 수 있음)"
                            className={styles.btnSmallGhost + " text-gray-400 cursor-not-allowed"}>
                            완료
                          </button>
                        ) : (
                          <button onClick={() => handlePromote(row._key)} className={styles.btnSmall}>
                            진행
                          </button>
                        )}
                      </div>
                    </td>
                    <td className={td}>
                      <input {...cellProps(row, "wholesale_name")}
                        readOnly={isReg}
                        className={inp + " font-medium" + lockTxt} />
                    </td>
                    <td className={td}>
                      <input {...cellProps(row, "option1")} readOnly={isReg} className={inp + lockTxt} />
                    </td>
                    <td className={td}>
                      <input {...cellProps(row, "option2")} readOnly={isReg} className={inp + lockTxt} />
                    </td>
                    <td className={td}>
                      <input {...cellProps(row, "option3")} readOnly={isReg} className={inp + lockTxt} />
                    </td>
                    <td className={td}>
                      <input id={`cell-${row._key}-wholesale_price`}
                        type="text" inputMode="numeric"
                        value={formatComma(row.wholesale_price)}
                        onChange={e => updateCell(row._key, "wholesale_price", parseDigits(e.target.value))}
                        onKeyDown={e => handleNav(e, row._key, "wholesale_price")}
                        readOnly={isReg}
                        className={inp + " text-right" + lockTxt} />
                    </td>
                    <td className={td}>
                      <input id={`cell-${row._key}-wholesale_discount_price`}
                        type="text" inputMode="numeric"
                        value={formatComma(row.wholesale_discount_price)}
                        onChange={e => updateCell(row._key, "wholesale_discount_price", parseDigits(e.target.value))}
                        onKeyDown={e => handleNav(e, row._key, "wholesale_discount_price")}
                        readOnly={isReg}
                        className={inp + " text-right" + lockTxt} />
                    </td>
                    <td className={td}>
                      <input {...cellProps(row, "country_of_origin")} readOnly={isReg} className={inp + lockTxt} />
                    </td>
                    <td className={td}>
                      <input {...cellProps(row, "material_composition")} readOnly={isReg} className={inp + lockTxt} />
                    </td>
                    <td className={td}>
                      <input {...cellProps(row, "wholesale_supplier")} readOnly={isReg} className={inp + lockTxt} />
                    </td>
                    {/* 카테고리: dropdown (measurement_templates). 진행 시 그대로 /products 로 박제 박혀감. */}
                    <td className={td + " p-0" + (row.category ? "" : " bg-orange-50")}>
                      <select value={row.category ?? ""}
                        onChange={e => updateSampleCategory(row, e.target.value)}
                        disabled={isReg || !row.id}
                        className={inp + " w-full" + lockTxt}>
                        <option value="">— 선택 —</option>
                        {measureCategories.map(c => <option key={c} value={c}>{c}</option>)}
                      </select>
                    </td>
                    <td className={td + " text-center border-r-0"}>
                      <button onClick={() => handleDelete(row._key)}
                        className="text-red-400 hover:text-red-600 text-sm leading-none">×</button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <Pagination page={page} pageSize={pageSize} total={total} onChange={setPage} />
      </main>

      {memoModalRow && (
        <MemoModal
          title="메모"
          initialValue={memoModalRow.description}
          onSave={async (val) => {
            if (!memoModalRow.id) return;
            await supabase.from("products")
              .update({ description: val.trim() || null, updated_at: new Date().toISOString() })
              .eq("id", memoModalRow.id);
            // 로컬 state 도 갱신 (재 fetch 안 해도 표 반영)
            setRows(prev => prev.map(r => r._key === memoModalRow._key ? { ...r, description: val } : r));
          }}
          onClose={() => setMemoModalRow(null)}
        />
      )}

      {sizeModalRow && tenant && (
        <SizeModal
          tenantId={tenant.id}
          productId={sizeModalRow.id!}
          productName={sizeModalRow.wholesale_name || sizeModalRow.product_code}
          initialSizes={split(sizeModalRow.option2)}
          initialCategory={sizeModalRow.category || null}
          onClose={() => setSizeModalRow(null)}
          onSaved={() => {
            setSizeModalRow(null);
            // 카테고리 변경 가능 → row state 도 갱신 (fetchItems 다시)
            fetchItems(tenant.id);
          }}
        />
      )}
    </div>
  );
}
