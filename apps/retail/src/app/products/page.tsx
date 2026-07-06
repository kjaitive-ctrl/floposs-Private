"use client";

import { useEffect, useRef, useState, KeyboardEvent, ChangeEvent, Fragment } from "react";
import { supabase } from "@/lib/supabase";
import { PRODUCT_STATUSES } from "@/common/constants";
import { styles } from "@/common/styles";
import { useTenant } from "@/lib/TenantContext";
import { formatComma, parseDigits } from "@/lib/format";
import {
  joinUniq, materialToText, newKey, split,
  type DbProduct, type Variant,
} from "@/lib/samplesUtils";
import { shortLocFromNested } from "@/lib/retailSuppliers";
import SizeModal from "@/components/SizeModal";
import CommentModal from "@/components/CommentModal";
import ShootModal from "@/components/ShootModal";
import ProductImagesModal from "@/components/ProductImagesModal";
import OptionChipCell from "@/components/OptionChipCell";
import MemoModal from "@/components/MemoModal";
import PriceModal from "@/components/PriceModal";
import PriceHistoryModal from "@/components/PriceHistoryModal";
import Cafe24PushModal from "@/components/Cafe24PushModal";
import SaveStatusDot from "@/components/SaveStatusDot";
import Pagination from "@/components/Pagination";
import ProductsToolbar, { type SearchCol, type SoldOutFilter } from "@/components/ProductsToolbar";
import { useCellNavigation } from "@/lib/useCellNavigation";
import { useRowAutosave } from "@/lib/useRowAutosave";
import { useCategoryOptions } from "@/lib/useCategoryOptions";
// excelUtils 는 dynamic import — xlsx 라이브러리가 [엑셀 다운로드] 클릭 시점에만 로드

// /products = 정식 등록된 상품 (status IN registered/inactive).
// 4개 컬럼(상품명/옵션1/2/3) 은 samples 와 동일 인터페이스로 인라인 input + 자동저장.
// 컬럼 박제: products.consumer_name + consumer_option1/2/3 (마이그 186). 공급(wholesale_*) 과 별개 set.
// 그 외 셀은 read-only (공급 정보 표시).

interface ProductRow {
  _key: string;
  id: string;
  product_code: string;  // 엑셀 다운로드 / 표시 (옛 도매 product_code)
  barcode: string | null;  // 마이그 198: 진행 시 자동 발급 (Code 128, 18자리), 샘플로 회귀 시 NULL
  category: string;  // SizeModal initialCategory 용
  // read-only 표시용 (samples 박제 정보 — 아래 줄)
  description: string;
  wholesale_name: string;
  wholesale_supplier: string;
  supplier_loc: string;          // 축약 위치 "디오트1J" (마이그 036 nested)
  wholesale_price: number | null;          // 원본 도매가 (샘플 박제, read-only 참고)
  wholesale_discount_price: number | null;
  wholesale_price_current: string;          // 현재 도매가 (편집 — 빈값이면 원본 사용). 마이그 206
  country_of_origin: string;
  material_composition: string;
  wholesale_options: { o1: string; o2: string; o3: string };
  // variant 단위 정공법 (마이그 188) — 위 줄 chip 인터페이스 박제
  variants: Variant[];
  // products 측 박제 (위 줄)
  consumer_name: string;
  progress_memo: string;
  // 가격 (위 줄 3칸) — string 박제 (UI), saveRowByKey 시 Number 변환
  sale_price: string;          // 판매가 = 실제 판매가 (재사용 컬럼)
  consumer_price: string;       // 소비자가 = 정가 (마이그 182)
  regular_sale_price: string;   // 상시판매가 = 상시할인가 (마이그 182)
  // 마이그 201 — 상품 전체 품절 토글
  sold_out: boolean;
  // product_images 등록 개수 — 0 보다 크면 [샘플로] 차단
  image_count: number;
  // product_measurements 박제 row 수 — 0 이면 SIZE 버튼 옅은 주황 (사이즈 측정값 미박제)
  measurements_count: number;
  // MD기능 버튼 초록 표시용: 멘트(products.comment_data) / 촬영(product_shoots) 등록 여부
  has_comment: boolean;
  shoot_count: number;
  // 카페24 전송 여부 (마이그 209 — products.cafe24_product_no)
  cafe24_product_no: number | null;
}

export default function ProductsPage() {
  const { tenant, loading: tenantLoading, error: tenantError } = useTenant();
  const [rows, setRows] = useState<ProductRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [sizeModalRow, setSizeModalRow] = useState<ProductRow | null>(null);
  const [commentModalRow, setCommentModalRow] = useState<ProductRow | null>(null);
  const [shootModalRow, setShootModalRow] = useState<ProductRow | null>(null);
  const [imagesModalRow, setImagesModalRow] = useState<ProductRow | null>(null);
  const [priceModalRow, setPriceModalRow] = useState<ProductRow | null>(null);
  const [historyRow, setHistoryRow] = useState<ProductRow | null>(null);
  // 일괄 액션용 일시 선택 state (DB 박제 X, 새로고침 시 초기화)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [cafe24PushOpen, setCafe24PushOpen] = useState(false);
  // 메모 모달 — 메모(진행)=progress_memo 편집, 메모(샘플)=description 읽기 전용
  const [memoModal, setMemoModal] = useState<{ row: ProductRow; kind: "progress" | "sample" } | null>(null);
  // 카테고리 dropdown 옵션 (measurement_templates 시스템 공통 + tenant 커스텀)
  const [measureCategories, setMeasureCategories] = useState<string[]>([]);

  // ── 검색/필터/페이지네이션 ──
  // 한 상품 = 2 tr 이라 기본 25개 (= 50 tr). samples 와 동일 인터페이스.
  const [searchCol, setSearchCol] = useState<SearchCol>("consumer_name");
  const [appliedSearch, setAppliedSearch] = useState("");
  const [category, setCategory] = useState("");
  const [soldOutFilter, setSoldOutFilter] = useState<SoldOutFilter>("all");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [total, setTotal] = useState(0);
  const categoryOptions = useCategoryOptions(tenant?.id);

  function toggleSelect(id: string) {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  // saveRow callback 안에서 항상 최신 rows 참조 — render 후 effect 에서 ref 갱신.
  const rowsRef = useRef(rows);
  useEffect(() => { rowsRef.current = rows; });

  // 자동저장 hook — saveRow 가 실 UPDATE 로직, hook 이 timers/inFlight/dirtyAgain + setSaveStatus 관리
  const { saveState, setSaveStatus, scheduleAutosave } = useRowAutosave({
    saveRow: async (rowKey) => {
      const row = rowsRef.current.find(r => r._key === rowKey);
      if (!row?.id) return { ok: true };  // skip
      const { error } = await supabase.from("products").update({
        consumer_name: row.consumer_name.trim() || null,
        sale_price:          row.sale_price          ? Number(row.sale_price)          : null,
        consumer_price:      row.consumer_price      ? Number(row.consumer_price)      : null,
        regular_sale_price:  row.regular_sale_price  ? Number(row.regular_sale_price)  : null,
        updated_at: new Date().toISOString(),
      }).eq("id", row.id);
      if (error) console.error("UPDATE failed:", error);
      return { ok: !error };
    },
  });

  // select 절 — fetchItems / refetchOneProduct 공통.
  // product_measurements(count) — SIZE 버튼 판정용 (박제 0 시 옅은 주황).
  // product_variants.sort_order — toRow active 정렬 기준 (마이그 033, 클라이언트 INSERT 순 박제)
  const PRODUCT_SELECT = "id, product_code, barcode, cafe24_product_no, wholesale_name, wholesale_supplier, category, wholesale_price, wholesale_discount_price, wholesale_price_current, sale_price, consumer_price, regular_sale_price, status, launch_date, return_deadline, return_shipped_date, description, country_of_origin, material_composition, retail_supplier_id, retail_suppliers(slots(building, floor, section, unit)), consumer_name, progress_memo, comment_data, sold_out, product_variants(id, color, size, option3, is_active, consumer_label_color, consumer_label_size, consumer_label_option3, is_for_sale, sold_out, variant_code, sort_order), product_images(count), product_shoots(count), product_measurements(count)";

  // DbProduct → ProductRow. existingKey 보존하면 React reconciliation 동일 row 인식 → DOM 재생성 X.
  function toRow(p: DbProduct, existingKey?: string): ProductRow {
    // is_active=true 필터 + sort_order ASC 정렬 (마이그 033, 클라이언트 INSERT 순 박제).
    const active = (p.product_variants ?? [])
      .filter(v => v.is_active !== false)
      .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0));
    const vs: Variant[] = active.map(v => ({
      id: v.id,
      color: v.color,
      size: v.size,
      option3: v.option3,
      consumer_label_color: v.consumer_label_color ?? v.color,
      consumer_label_size: v.consumer_label_size ?? v.size,
      consumer_label_option3: v.consumer_label_option3 ?? v.option3,
      is_for_sale: v.is_for_sale ?? true,
      sold_out: v.sold_out ?? false,
      variant_code: v.variant_code ?? null,
      sort_order: (v as { sort_order?: number }).sort_order ?? 0,  // chip 정렬 일관성 (마이그 033)
    }));
    return {
      _key: existingKey ?? newKey(),
      id: p.id,
      product_code: p.product_code ?? "",
      barcode: p.barcode ?? null,
      category: p.category ?? "",
      description: p.description ?? "",
      wholesale_name: p.wholesale_name ?? "",
      wholesale_supplier: p.wholesale_supplier ?? "",
      supplier_loc: shortLocFromNested(p.retail_suppliers),
      wholesale_price: p.wholesale_price,
      wholesale_discount_price: p.wholesale_discount_price,
      wholesale_price_current: p.wholesale_price_current?.toString() ?? "",
      country_of_origin: p.country_of_origin ?? "",
      material_composition: materialToText(p.material_composition),
      wholesale_options: {
        o1: joinUniq(vs, "color"),
        o2: joinUniq(vs, "size"),
        o3: joinUniq(vs, "option3"),
      },
      variants: vs,
      consumer_name: p.consumer_name ?? "",
      progress_memo: p.progress_memo ?? "",
      sale_price:          p.sale_price?.toString() ?? "",
      consumer_price:      p.consumer_price?.toString() ?? "",
      regular_sale_price:  p.regular_sale_price?.toString() ?? "",
      sold_out:            p.sold_out ?? false,
      image_count:         p.product_images?.[0]?.count ?? 0,
      measurements_count:  p.product_measurements?.[0]?.count ?? 0,
      has_comment:         !!(p.comment_data && p.comment_data.trim()),
      shoot_count:         p.product_shoots?.[0]?.count ?? 0,
      cafe24_product_no:   (p as { cafe24_product_no?: number | null }).cafe24_product_no ?? null,
    };
  }

  async function fetchItems(tenantId: string) {
    setLoading(true);
    const offset = (page - 1) * pageSize;
    let query = supabase
      .from("products")
      .select(PRODUCT_SELECT, { count: "exact" })
      .eq("tenant_id", tenantId)
      .eq("is_active", true)
      .in("status", PRODUCT_STATUSES);
    if (appliedSearch) query = query.ilike(searchCol, `%${appliedSearch}%`);
    if (category)      query = query.eq("category", category);
    if (soldOutFilter === "active")   query = query.eq("sold_out", false);
    if (soldOutFilter === "sold_out") query = query.eq("sold_out", true);
    const { data, count } = await query
      .order("created_at", { ascending: false })
      .range(offset, offset + pageSize - 1);
    const items = (data ?? []) as DbProduct[];
    setTotal(count ?? 0);
    setRows(items.map(p => toRow(p)));
    setLoading(false);
  }

  // measurement_templates 카테고리 옵션 fetch — row 의 카테고리 dropdown 용
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

  async function updateCategory(row: ProductRow, newCategory: string) {
    if (row.category === newCategory) return;
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
    refetchOneProduct(row.id);
  }

  // 한 product 만 부분 fetch — chip 변경/모달 onSaved 등 위치 불변 갱신용.
  // _key 보존 → React 가 같은 row 로 인식 → DOM 재생성 X → 깜빡임 0.
  async function refetchOneProduct(productId: string) {
    const { data, error } = await supabase
      .from("products")
      .select(PRODUCT_SELECT)
      .eq("id", productId)
      .maybeSingle();
    if (error || !data) return;
    setRows(prev => prev.map(r => r.id === productId ? toRow(data as DbProduct, r._key) : r));
  }

  useEffect(() => {
    // fetchItems 는 async — 내부 await 후 setState 라 lint set-state-in-effect 는 false positive.
    // (effect body 자체는 setState 안 부름; data fetching 은 effect 의 정상 사용처.)
    // page/pageSize/appliedSearch/searchCol/category/soldOutFilter 변경 시 자동 재조회.
    // eslint-disable-next-line react-hooks/set-state-in-effect, react-hooks/exhaustive-deps
    if (tenant?.id) fetchItems(tenant.id);
  }, [tenant?.id, page, pageSize, appliedSearch, searchCol, category, soldOutFilter]);

  type EditField = "consumer_name" | "sale_price" | "consumer_price" | "regular_sale_price";

  function updateCell(rowKey: string, field: EditField, value: string) {
    setRows(prev => {
      const idx = prev.findIndex(r => r._key === rowKey);
      if (idx < 0) return prev;
      const next = [...prev];
      next[idx] = { ...next[idx], [field]: value };
      return next;
    });
    scheduleAutosave(rowKey);
  }

  async function toggleProductSoldOut(row: ProductRow) {
    const next = !row.sold_out;
    // 낙관적 업데이트
    setRows(prev => prev.map(r => r.id === row.id ? { ...r, sold_out: next } : r));
    const { error } = await supabase.from("products")
      .update({ sold_out: next, updated_at: new Date().toISOString() })
      .eq("id", row.id);
    if (error) {
      alert(`전체품절 토글 실패: ${error.message}`);
      // 롤백
      setRows(prev => prev.map(r => r.id === row.id ? { ...r, sold_out: row.sold_out } : r));
    }
  }

  async function handleRevert(row: ProductRow) {
    // 이미지 등록 시 회귀 차단 (사장 결정 2026-05-29) — 샘플 단계엔 이미지 X
    if (row.image_count > 0) {
      alert(`이미지가 ${row.image_count}장 등록되어 있어 샘플로 되돌릴 수 없습니다.\n[IMG] 모달에서 먼저 모든 이미지를 삭제하세요.`);
      return;
    }
    // 마이그 198: 바코드 폐기 안내 (외부 push 동기화는 미래 작업)
    const msg = "샘플 단계로 되돌리면:\n"
      + "• 발급된 바코드가 폐기됩니다 (재진행 시 새 바코드)\n"
      + "• 종이 라벨 출력된 바코드가 있다면 수거 필요\n"
      + "• 카페24 등 외부 플랫폼에 등록된 경우 별도 동기화 필요\n\n"
      + "계속하시겠습니까?";
    if (!confirm(msg)) return;

    // 바코드 폐기 (RPC: products.barcode NULL + variants barcode NULL + history revoked 박제)
    const { error: revokeError } = await supabase.rpc("revoke_product_barcode", {
      p_product_id: row.id,
      p_reason: "샘플로 회귀",
    });
    if (revokeError) {
      console.error("바코드 폐기 실패:", revokeError);
      alert(`바코드 폐기 실패: ${revokeError.message}`);
      return;
    }

    // status 변경
    await supabase.from("products")
      .update({ status: "sample_received", updated_at: new Date().toISOString() })
      .eq("id", row.id);
    if (tenant?.id) fetchItems(tenant.id);
  }

  // hook 은 early return 위에 둬야 Rules of Hooks 안 깨짐 (Aw-Snap 회귀 방지).
  const handleNav = useCellNavigation({ rowsRef });

  if (tenantLoading) {
    return <div className={styles.page}><main className="px-6 py-8 text-xs text-gray-400">불러오는 중...</main></div>;
  }
  if (tenantError || !tenant) {
    return <div className={styles.page}><main className="px-6 py-8 text-xs text-red-500">tenant 정보 조회 실패: {tenantError}</main></div>;
  }

  // 헤더 2 row 구조. 위/아래 각각 h-9 (36px) → 둘째 tr 의 sticky top-9.
  const thBase = "px-2 py-2 text-xs font-medium text-gray-600 border-r border-gray-200 whitespace-nowrap z-20 text-center h-9";
  // 위 줄 — 노란 음영 5개 (메모/상품명/옵션1·2·3) + 공란 (사장 미지정)
  const thTop      = thBase + " bg-gray-100 sticky top-0";
  const thTopInput = thBase + " bg-yellow-50 sticky top-0";
  // 아래 줄 — samples 박제 헤더 (공급가/할인가/제조국/혼용율/공급사) + 액션. 메모~옵션3 자리 공란
  const thBot = thBase + " bg-gray-100 sticky top-9";
  const td = "border-r border-r-gray-100 align-middle";
  const inp = "w-full px-2 py-1.5 text-xs bg-transparent text-black placeholder:text-gray-500 focus:outline-none focus:bg-white focus:ring-1 focus:ring-black focus:ring-inset";

  function cellProps(row: ProductRow, col: EditField) {
    return {
      id: `cell-${row._key}-${col}`,
      value: row[col],
      onChange: (e: ChangeEvent<HTMLInputElement>) => updateCell(row._key, col, e.target.value),
      onKeyDown: (e: KeyboardEvent<HTMLInputElement>) => handleNav(e, row._key, col),
    };
  }


  return (
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
          soldOutFilter={soldOutFilter}
          onSoldOutFilterChange={f => { setSoldOutFilter(f); setPage(1); }}
          rightActions={<>
            {selectedIds.size > 0 && (
              <button
                onClick={() => setCafe24PushOpen(true)}
                className={styles.btnSmall + " py-1 !border-blue-400 !text-blue-700 hover:!bg-blue-50"}>
                카페24 전송 {selectedIds.size}개
              </button>
            )}
            <button onClick={async () => {
              const { exportProductsToExcel } = await import("@/lib/excelUtils");
              exportProductsToExcel(rows.map(r => ({
                product_code: r.product_code,
                barcode: r.barcode,
                progress_memo: r.progress_memo,
                consumer_name: r.consumer_name,
                variants: r.variants,
                regular_sale_price: r.regular_sale_price,
                sale_price: r.sale_price,
                consumer_price: r.consumer_price,
                description: r.description,
                wholesale_name: r.wholesale_name,
                wholesale_price: r.wholesale_price,
                wholesale_discount_price: r.wholesale_discount_price,
                country_of_origin: r.country_of_origin,
                material_composition: r.material_composition,
                wholesale_supplier: r.wholesale_supplier,
              })));
            }}
              className={styles.btnSmall + " py-1"}>
              엑셀 다운로드
            </button>
            <button onClick={async () => {
              if (!tenant?.id) { alert("tenant 미정"); return; }
              const { downloadSizeMeasurements } = await import("@/lib/excelUtils");
              try { await downloadSizeMeasurements(tenant.id); }
              catch (e) { alert((e as Error).message); }
            }}
              className={styles.btnSmall + " py-1"}>
              사이즈 다운로드
            </button>
            <label className={styles.btnSmall + " py-1 cursor-pointer"}>
              사이즈 업로드
              <input type="file" accept=".xlsx" className="hidden"
                onChange={async (e: ChangeEvent<HTMLInputElement>) => {
                  const f = e.target.files?.[0];
                  if (!f || !tenant?.id) return;
                  const { uploadSizeMeasurements } = await import("@/lib/excelUtils");
                  const res = await uploadSizeMeasurements(f, tenant.id);
                  const msg = `완료: 성공 ${res.success} / 실패 ${res.failed}` +
                    (res.errors.length ? `\n\n[에러 ${res.errors.length}건]\n${res.errors.slice(0, 5).join("\n")}` : "");
                  alert(msg);
                  e.target.value = ""; // 같은 파일 재선택 가능
                }} />
            </label>
          </>}
        />
      </header>

      <main className="flex-1 overflow-hidden min-h-0 flex flex-col">
        <div className="flex-1 overflow-auto bg-white">
          <table className="min-w-full" style={{ borderCollapse: "separate", borderSpacing: 0 }}>
            <thead className="border-b-2 border-b-gray-300 shadow">
              {/* 위 줄: 노란 음영 5개 (입력 가능 컬럼명). 그 외 공란. ● 는 rowSpan=2 */}
              <tr>
                <th rowSpan={2} className={thTop + " w-6"}></th>
                <th rowSpan={2} className={thTop + " w-8 cursor-pointer hover:bg-gray-200"}
                  title="전체선택"
                  onClick={() => {
                    const allSelected = rows.length > 0 && rows.every(r => selectedIds.has(r.id));
                    const next = new Set(selectedIds);
                    if (allSelected) rows.forEach(r => next.delete(r.id));
                    else rows.forEach(r => next.add(r.id));
                    setSelectedIds(next);
                  }}>
                  <div className="flex flex-col items-center gap-0.5 pointer-events-none">
                    <input type="checkbox" readOnly
                      checked={rows.length > 0 && rows.every(r => selectedIds.has(r.id))}
                      ref={el => {
                        if (el) el.indeterminate = rows.some(r => selectedIds.has(r.id))
                          && !rows.every(r => selectedIds.has(r.id));
                      }} />
                    <span className="text-[10px] text-gray-500 leading-none">전체</span>
                  </div>
                </th>
                <th className={thTopInput + " min-w-[140px]"}>메모(진행)</th>
                <th rowSpan={2} className={thTop + " w-8"} title="플랫폼 전송 현황"></th>
                <th className={thTopInput + " min-w-[160px]"}>상품명</th>
                <th className={thTopInput + " min-w-[130px]"}>옵션1</th>
                <th className={thTopInput + " min-w-[130px]"}>옵션2 (사이즈)</th>
                <th className={thTopInput + " min-w-[110px]"}>옵션3</th>
                <th className={thTopInput + " w-32"}>상시판매가</th>
                <th className={thTopInput + " w-32"}>판매가</th>
                <th className={thTopInput + " w-32"}>소비자가</th>
                <th className={thTopInput + " w-32"}>카테고리</th>
                <th className={thTopInput + " w-32"}>상품코드</th>
                <th className={thTopInput + " w-32 border-r-0"}>MD기능</th>
              </tr>
              {/* 아래 줄: samples 박제 헤더 */}
              <tr>
                <th className={thBot + " min-w-[140px]"}>메모(샘플)</th>
                <th className={thBot + " min-w-[160px]"}>공급상품명</th>
                <th className={thBot + " min-w-[130px]"}>옵션1 (색상)</th>
                <th className={thBot + " min-w-[130px]"}>옵션2 (사이즈)</th>
                <th className={thBot + " min-w-[110px]"}>옵션3</th>
                <th className={thBot + " w-32"}>공급가</th>
                <th className={thBot + " w-32"}>할인가</th>
                <th className={thBot + " w-32"}>제조국</th>
                <th className={thBot + " w-24"}>혼용율</th>
                <th className={thBot + " min-w-[180px]"}>공급사</th>
                <th className={thBot + " w-32 border-r-0"}>액션</th>
              </tr>
            </thead>
            {loading ? (
              <tbody><tr><td colSpan={14} className="px-3 py-6 text-center text-xs text-gray-600">불러오는 중...</td></tr></tbody>
              ) : rows.length === 0 ? (
              <tbody><tr><td colSpan={14} className="px-3 py-6 text-center text-xs text-gray-400">등록된 상품이 없습니다. /samples 에서 [진행] 버튼으로 등록하세요.</td></tr></tbody>
              ) : rows.map((row, i) => {
                // 한 상품 = 2 tr (사장 결정).
                //   ● 만 rowSpan=2. 나머지는 모두 위/아래 분할.
                //   위 줄 = 입력 가능 셀 (메모/상품명/옵션1·2·3). 사장 미지정 칸은 공란 (레이아웃만).
                //   아래 줄 = samples 에서 넘어온 정보 (공급 정보 read-only). 메모 위치는 공란.
                //   한 상품 단위 구분 = 아래 tr td 에 border-b-gray-200 진한 선.
                //   한 상품 안 위/아래 사이 = 옅은 선 (border-b-gray-100).
                // 위/아래 줄 높이 통일 = h-9 (36px). input/텍스트 모두 align-middle 로 가운데 정렬.
                const tdTop  = "border-r border-r-gray-100 align-middle h-9";
                const tdBot  = "px-2 py-1.5 border-r border-r-gray-100 border-b-2 border-b-gray-300 text-xs text-gray-500 align-middle h-9";
                // 상품 단위 zebra (짝수 행 옅은 음영) — 100개 리스트에서 상품 덩어리 구분 (Gestalt 공통영역)
                const zebra  = i % 2 === 1 ? "bg-gray-100/70" : "";
                return (
                  <tbody key={row._key} className={"group " + zebra}>
                    <tr className="group-hover:bg-sky-50/60">
                      <td rowSpan={2} className={td + " text-center border-b-2 border-b-gray-300"}><SaveStatusDot status={saveState[row._key]} /></td>
                      <td rowSpan={2}
                        onClick={() => toggleSelect(row.id)}
                        className={td + " text-center border-b-2 border-b-gray-300 cursor-pointer hover:bg-gray-50"}>
                        <input type="checkbox"
                          checked={selectedIds.has(row.id)}
                          onChange={() => {}}
                          className="pointer-events-none" />
                      </td>
                      {/* 메모(진행): 위=progress_memo. 클릭 시 MemoModal 열림 (줄바꿈 가능) */}
                      <td className={tdTop + " cursor-pointer hover:bg-yellow-100/40"}
                        onClick={() => setMemoModal({ row, kind: "progress" })}>
                        <div className="px-2 py-1.5 text-xs text-black truncate max-w-[140px]">
                          {row.progress_memo || <span className="text-gray-400">메모 (클릭)</span>}
                        </div>
                      </td>
                      {/* 플랫폼 아이콘 셀 (rowSpan=2) — 전송된 플랫폼 뱃지 표시. 플랫폼 추가 시 아이콘만 추가 */}
                      <td rowSpan={2} className={td + " text-center border-b-2 border-b-gray-300 w-8"}>
                        <div className="flex flex-col items-center gap-1">
                          {row.cafe24_product_no ? (
                            <div
                              title={`카페24 상품번호: ${row.cafe24_product_no}`}
                              className="w-[18px] h-[18px] rounded flex items-center justify-center text-white text-[10px] font-bold leading-none select-none"
                              style={{ backgroundColor: "#0C6FFF" }}>
                              C
                            </div>
                          ) : (
                            <div
                              title="카페24 미전송"
                              className="w-[18px] h-[18px] rounded flex items-center justify-center text-[10px] font-bold leading-none select-none border border-gray-200 text-gray-300">
                              C
                            </div>
                          )}
                        </div>
                      </td>
                      {/* 상품명: 위=consumer_name input + 전체품절 토글 (사장 결정 2026-05-29, 마이그 201) */}
                      <td className={tdTop + " p-0" + (row.consumer_name.trim() ? "" : " bg-orange-50")}>
                        <div className="flex items-center gap-1 pr-1 h-full">
                          <input {...cellProps(row, "consumer_name")} placeholder="소비자 상품명"
                            className={inp + " font-medium" + (row.sold_out ? " line-through text-gray-400" : " text-blue-800")} />
                          <button onClick={() => toggleProductSoldOut(row)}
                            title={row.sold_out ? "전체품절 해제" : "상품 전체 품절 처리"}
                            className={"text-[10px] px-1.5 py-0.5 rounded border whitespace-nowrap shrink-0 " + (
                              row.sold_out
                                ? "bg-red-600 text-white border-red-600 hover:bg-red-700"
                                : "bg-white text-gray-600 border-gray-300 hover:bg-gray-50"
                            )}>
                            {row.sold_out ? "품절중" : "품절"}
                          </button>
                        </div>
                      </td>
                      {/* 옵션1/2/3: variant 단위 chip 인터페이스 (마이그 188). 통째 텍스트 수정 차단 */}
                      <td className={tdTop + " p-0"}>
                        <OptionChipCell productId={row.id} variants={row.variants} axis="color"
                          onChanged={() => refetchOneProduct(row.id)} />
                      </td>
                      <td className={tdTop + " p-0"}>
                        <OptionChipCell productId={row.id} variants={row.variants} axis="size"
                          onChanged={() => refetchOneProduct(row.id)} />
                      </td>
                      <td className={tdTop + " p-0"}>
                        <OptionChipCell productId={row.id} variants={row.variants} axis="option3"
                          onChanged={() => refetchOneProduct(row.id)} />
                      </td>
                      {/* 상시판매가 / 판매가 / 소비자가: 위=가격 input (콤마 포맷). 제조국/혼용율/공급사/액션 위=공란 */}
                      <td className={tdTop + (row.regular_sale_price ? "" : " bg-orange-50")}>
                        <input id={`cell-${row._key}-regular_sale_price`}
                          type="text" inputMode="numeric"
                          value={formatComma(row.regular_sale_price)}
                          onChange={e => updateCell(row._key, "regular_sale_price", parseDigits(e.target.value))}
                          onKeyDown={e => handleNav(e, row._key, "regular_sale_price")}
                          className={inp + " text-right"} />
                      </td>
                      <td className={tdTop}>
                        <input id={`cell-${row._key}-sale_price`}
                          type="text" inputMode="numeric"
                          value={formatComma(row.sale_price)}
                          onChange={e => updateCell(row._key, "sale_price", parseDigits(e.target.value))}
                          onKeyDown={e => handleNav(e, row._key, "sale_price")}
                          className={inp + " text-right"} />
                      </td>
                      <td className={tdTop}>
                        <input id={`cell-${row._key}-consumer_price`}
                          type="text" inputMode="numeric"
                          value={formatComma(row.consumer_price)}
                          onChange={e => updateCell(row._key, "consumer_price", parseDigits(e.target.value))}
                          onKeyDown={e => handleNav(e, row._key, "consumer_price")}
                          className={inp + " text-right"} />
                      </td>
                      {/* 카테고리: dropdown (measurement_templates 정의 — 시스템 + tenant 커스텀)
                          SizeModal 의 카테고리 선택을 여기로 이동 (2026-05-29). 사이즈 모달은 추종. */}
                      <td className={tdTop + " p-0" + (row.category ? "" : " bg-orange-50")}>
                        <select value={row.category}
                          onChange={e => updateCategory(row, e.target.value)}
                          className={inp + " w-full"}>
                          <option value="">— 선택 —</option>
                          {measureCategories.map(c => <option key={c} value={c}>{c}</option>)}
                        </select>
                      </td>
                      {/* 상품코드: 진행 시 자동 발급된 바코드 (마이그 198, 18자리). 샘플 상태면 "-". */}
                      <td className={tdTop + " text-center"}>
                        <span className="text-[11px] font-mono text-black select-all">
                          {row.barcode ?? <span className="text-gray-300">-</span>}
                        </span>
                      </td>
                      {/* MD기능: 멘트 / 촬영 / IMG.
                          하나라도 등록(멘트=comment_data, 촬영=product_shoots, 이미지=product_images)되면
                          해당 버튼 배경 초록으로 (등록됨 시각 표시). */}
                      <td className={tdTop + " border-r-0 text-center"}>
                        <div className="flex gap-1 justify-center">
                          <button onClick={() => setCommentModalRow(row)}
                            className={styles.btnSmall + " whitespace-nowrap" + (row.has_comment ? " !bg-black !text-white !border-black hover:!bg-gray-800" : "")}>멘트</button>
                          <button onClick={() => setShootModalRow(row)}
                            className={styles.btnSmall + " whitespace-nowrap" + (row.shoot_count > 0 ? " !bg-black !text-white !border-black hover:!bg-gray-800" : "")}>촬영</button>
                          <button onClick={() => setImagesModalRow(row)}
                            className={styles.btnSmall + " whitespace-nowrap" + (row.image_count > 0 ? " !bg-black !text-white !border-black hover:!bg-gray-800" : "")}>IMG</button>
                        </div>
                      </td>
                    </tr>
                    <tr className="group-hover:bg-sky-50/60">
                      {/* ● 자리는 위 tr 의 rowSpan=2 가 차지 */}
                      {/* 메모(샘플): 아래=description read-only. 클릭 시 모달로 전체 보기 */}
                      <td className={tdBot + " cursor-pointer hover:bg-gray-100 truncate max-w-[140px]"}
                        onClick={() => setMemoModal({ row, kind: "sample" })}>
                        {row.description || "-"}
                      </td>
                      {/* 상품명/옵션1/2/3: 아래=samples 박제 read-only */}
                      <td className={tdBot + " font-medium"}>{row.wholesale_name || "-"}</td>
                      <td className={tdBot}>{row.wholesale_options.o1 || "-"}</td>
                      <td className={tdBot}>{row.wholesale_options.o2 || "-"}</td>
                      <td className={tdBot}>{row.wholesale_options.o3 || "-"}</td>
                      {/* 공급가: 통제형 편집(모달 +/- 버튼) + 이력. 원본 보존, 현재가는 다음 전송부터. 마이그 206/207 */}
                      <td className={tdBot + " text-right"}>
                        <div className="flex items-center justify-end gap-1">
                          <button type="button" onClick={() => setPriceModalRow(row)}
                            title={row.wholesale_price != null ? `원본 ${formatComma(String(row.wholesale_price))}원 (눌러서 수정)` : "도매가 수정"}
                            className={"px-1.5 py-0.5 rounded border text-xs " + (row.wholesale_price_current ? "border-rose-300 text-rose-700 bg-rose-50" : "border-gray-200 text-gray-700 hover:bg-gray-50")}>
                            {formatComma(row.wholesale_price_current) || formatComma(String(row.wholesale_price ?? "")) || "-"}
                          </button>
                          <button type="button" onClick={() => setHistoryRow(row)} title="가격 변경 이력"
                            className="text-gray-300 hover:text-gray-600">📜</button>
                        </div>
                      </td>
                      {/* 할인가/제조국/혼용율/공급사: 아래=samples 박제 read-only */}
                      <td className={tdBot + " text-right"}>{formatComma(row.wholesale_discount_price) || "-"}</td>
                      <td className={tdBot + " text-center"}>{row.country_of_origin || "-"}</td>
                      <td className={tdBot}>{row.material_composition || "-"}</td>
                      <td className={tdBot} title={row.wholesale_supplier ? [row.wholesale_supplier, row.supplier_loc].filter(Boolean).join(" · ") : undefined}>
                        {row.wholesale_supplier
                          ? <>{row.wholesale_supplier}{row.supplier_loc && <span className="text-gray-400"> · {row.supplier_loc}</span>}</>
                          : "-"}
                      </td>
                      {/* 액션: 아래=[SIZE] [샘플로]. 사이즈는 회계 무관 메타데이터라 상시 활성.
                          product_measurements 박제 row 가 0 이면 옅은 주황으로 환기 (사이즈표 미박제). */}
                      <td className={tdBot + " text-center border-r-0"}>
                        <div className="flex gap-1 justify-center">
                          <button onClick={() => setSizeModalRow(row)}
                            className={styles.btnSmall + (row.measurements_count > 0 ? "" : " !bg-orange-50")}>
                            SIZE
                          </button>
                          <button onClick={() => handleRevert(row)}
                            disabled={row.image_count > 0}
                            title={row.image_count > 0 ? `이미지 ${row.image_count}장 등록됨 — 먼저 삭제 후 가능` : "샘플 단계로 되돌리기"}
                            className={styles.btnSmallGhost + " whitespace-nowrap disabled:opacity-40 disabled:cursor-not-allowed"}>
                            샘플로
                          </button>
                        </div>
                      </td>
                    </tr>
                  </tbody>
                );
              })}
          </table>
        </div>
        <Pagination page={page} pageSize={pageSize} total={total} onChange={setPage} />
      </main>

      {memoModal && (
        <MemoModal
          title={memoModal.kind === "progress" ? "메모(진행)" : "메모(샘플)"}
          initialValue={memoModal.kind === "progress" ? memoModal.row.progress_memo : memoModal.row.description}
          readOnly={memoModal.kind === "sample"}
          onSave={async (val) => {
            const field = memoModal.kind === "progress" ? "progress_memo" : "description";
            await supabase.from("products")
              .update({ [field]: val.trim() || null, updated_at: new Date().toISOString() })
              .eq("id", memoModal.row.id);
            // 로컬 state 갱신 — 재 fetch 없이 표 반영 (samples 와 동일 패턴, 새로고침 방지)
            setRows(prev => prev.map(r => r.id === memoModal.row.id ? { ...r, [field]: val } : r));
          }}
          onClose={() => setMemoModal(null)}
        />
      )}

      {sizeModalRow && tenant && (
        <SizeModal
          tenantId={tenant.id}
          productId={sizeModalRow.id}
          productName={sizeModalRow.consumer_name || sizeModalRow.wholesale_name || ""}
          initialSizes={split(sizeModalRow.wholesale_options.o2)}
          initialCategory={sizeModalRow.category || null}
          onClose={() => setSizeModalRow(null)}
          onSaved={() => {
            setSizeModalRow(null);
            fetchItems(tenant.id);
          }}
        />
      )}

      {commentModalRow && tenant && (
        <CommentModal
          tenantId={tenant.id}
          productId={commentModalRow.id}
          productName={commentModalRow.consumer_name || commentModalRow.wholesale_name || ""}
          onClose={() => setCommentModalRow(null)}
          onSaved={() => {
            setCommentModalRow(null);
            fetchItems(tenant.id);
          }}
        />
      )}

      {shootModalRow && tenant && (
        <ShootModal
          tenantId={tenant.id}
          productId={shootModalRow.id}
          productName={shootModalRow.consumer_name || shootModalRow.wholesale_name || ""}
          ownVariants={shootModalRow.variants}
          onClose={() => setShootModalRow(null)}
          onSaved={() => {
            setShootModalRow(null);
            fetchItems(tenant.id);
          }}
        />
      )}

      {imagesModalRow && tenant && (
        <ProductImagesModal
          productId={imagesModalRow.id}
          productName={imagesModalRow.consumer_name || imagesModalRow.wholesale_name || ""}
          onClose={() => {
            setImagesModalRow(null);
            // image_count 갱신 — [샘플로] 가드 동기화 (사장 결정 2026-05-29)
            if (tenant?.id) fetchItems(tenant.id);
          }}
          onSaved={() => {
            // 모달 안에서 즉시 갱신하므로 list 만 별도 refresh 안 함 — 닫을 때 page refetch.
          }}
        />
      )}

      {priceModalRow && (
        <PriceModal
          productId={priceModalRow.id}
          productName={priceModalRow.consumer_name || priceModalRow.wholesale_name || ""}
          originalPrice={priceModalRow.wholesale_price}
          currentPrice={priceModalRow.wholesale_price_current ? Number(priceModalRow.wholesale_price_current) : null}
          onClose={() => setPriceModalRow(null)}
          onSaved={() => { setPriceModalRow(null); if (tenant?.id) fetchItems(tenant.id); }}
        />
      )}

      {historyRow && (
        <PriceHistoryModal
          productId={historyRow.id}
          productName={historyRow.consumer_name || historyRow.wholesale_name || ""}
          onClose={() => setHistoryRow(null)}
        />
      )}

      {cafe24PushOpen && (
        <Cafe24PushModal
          selectedIds={[...selectedIds]}
          rows={rows.map(r => ({
            id: r.id,
            consumer_name: r.consumer_name,
            wholesale_name: r.wholesale_name,
            image_count: r.image_count,
            cafe24_product_no: r.cafe24_product_no,
          }))}
          onClose={() => setCafe24PushOpen(false)}
          onDone={(updatedMap) => {
            // 성공한 상품의 cafe24_product_no 를 rows 에 반영 (재fetch 없이 즉시)
            setRows(prev => prev.map(r => {
              const no = updatedMap.get(r.id);
              return no != null ? { ...r, cafe24_product_no: no } : r;
            }));
            setCafe24PushOpen(false);
          }}
        />
      )}
    </div>
  );
}
