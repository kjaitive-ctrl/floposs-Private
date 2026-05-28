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
import SizeModal from "@/components/SizeModal";
import CommentModal from "@/components/CommentModal";
import ShootModal from "@/components/ShootModal";
import OptionChipCell from "@/components/OptionChipCell";
import MemoModal from "@/components/MemoModal";
import SaveStatusDot from "@/components/SaveStatusDot";
import Pagination from "@/components/Pagination";
import ProductsToolbar, { type SearchCol } from "@/components/ProductsToolbar";
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
  product_code: string;  // 엑셀 다운로드 / 표시
  category: string;  // SizeModal initialCategory 용
  // read-only 표시용 (samples 박제 정보 — 아래 줄)
  description: string;
  wholesale_name: string;
  wholesale_supplier: string;
  wholesale_price: number | null;
  wholesale_discount_price: number | null;
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
}

export default function ProductsPage() {
  const { tenant, loading: tenantLoading, error: tenantError } = useTenant();
  const [rows, setRows] = useState<ProductRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [sizeModalRow, setSizeModalRow] = useState<ProductRow | null>(null);
  const [commentModalRow, setCommentModalRow] = useState<ProductRow | null>(null);
  const [shootModalRow, setShootModalRow] = useState<ProductRow | null>(null);
  // 일괄 액션용 일시 선택 state (DB 박제 X, 새로고침 시 초기화)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  // 메모 모달 — 메모(진행)=progress_memo 편집, 메모(샘플)=description 읽기 전용
  const [memoModal, setMemoModal] = useState<{ row: ProductRow; kind: "progress" | "sample" } | null>(null);

  // ── 검색/필터/페이지네이션 ──
  // 한 상품 = 2 tr 이라 기본 25개 (= 50 tr). samples 와 동일 인터페이스.
  const [searchCol, setSearchCol] = useState<SearchCol>("wholesale_name");
  const [appliedSearch, setAppliedSearch] = useState("");
  const [category, setCategory] = useState("");
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
  const { saveState, scheduleAutosave } = useRowAutosave({
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

  async function fetchItems(tenantId: string) {
    setLoading(true);
    const offset = (page - 1) * pageSize;
    let query = supabase
      .from("products")
      .select("id, product_code, wholesale_name, wholesale_supplier, category, wholesale_price, wholesale_discount_price, sale_price, consumer_price, regular_sale_price, status, launch_date, return_deadline, return_shipped_date, description, country_of_origin, material_composition, consumer_name, progress_memo, product_variants(id, color, size, option3, is_active, consumer_label_color, consumer_label_size, consumer_label_option3, is_for_sale, sold_out, variant_code)", { count: "exact" })
      .eq("tenant_id", tenantId)
      .eq("is_active", true)
      .in("status", PRODUCT_STATUSES);
    if (appliedSearch) query = query.ilike(searchCol, `%${appliedSearch}%`);
    if (category)      query = query.eq("category", category);
    const { data, count } = await query
      .order("created_at", { ascending: false })
      .range(offset, offset + pageSize - 1);
    const items = (data ?? []) as DbProduct[];
    setTotal(count ?? 0);
    const list: ProductRow[] = items.map(p => {
      const active = (p.product_variants ?? []).filter(v => v.is_active !== false);
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
      }));
      return {
        _key: newKey(),
        id: p.id,
        product_code: p.product_code ?? "",
        category: p.category ?? "",
        description: p.description ?? "",
        wholesale_name: p.wholesale_name ?? "",
        wholesale_supplier: p.wholesale_supplier ?? "",
        wholesale_price: p.wholesale_price,
        wholesale_discount_price: p.wholesale_discount_price,
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
      };
    });
    setRows(list);
    setLoading(false);
  }

  useEffect(() => {
    // fetchItems 는 async — 내부 await 후 setState 라 lint set-state-in-effect 는 false positive.
    // (effect body 자체는 setState 안 부름; data fetching 은 effect 의 정상 사용처.)
    // page/pageSize/appliedSearch/searchCol/category 변경 시 자동 재조회.
    // eslint-disable-next-line react-hooks/set-state-in-effect, react-hooks/exhaustive-deps
    if (tenant?.id) fetchItems(tenant.id);
  }, [tenant?.id, page, pageSize, appliedSearch, searchCol, category]);

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

  async function handleRevert(id: string) {
    if (!confirm("이 상품을 샘플 단계로 되돌리시겠습니까?")) return;
    await supabase.from("products")
      .update({ status: "sample_received", updated_at: new Date().toISOString() })
      .eq("id", id);
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
  const td = "border-r border-gray-100 align-middle";
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
          rightActions={<>
            <button onClick={async () => {
              const { exportProductsToExcel } = await import("@/lib/excelUtils");
              exportProductsToExcel(rows.map(r => ({
                product_code: r.product_code,
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
          </>}
        />
      </header>

      <main className="flex-1 overflow-hidden min-h-0 flex flex-col">
        <div className="flex-1 overflow-auto bg-white">
          <table className="min-w-full" style={{ borderCollapse: "separate", borderSpacing: 0 }}>
            <thead className="border-b-2 border-gray-300 shadow">
              {/* 위 줄: 노란 음영 5개 (입력 가능 컬럼명). 그 외 공란. ● 는 rowSpan=2 */}
              <tr>
                <th rowSpan={2} className={thTop + " w-6"}></th>
                <th rowSpan={2} className={thTop + " w-8"}>
                  <span style={{ writingMode: "vertical-rl", textOrientation: "upright", letterSpacing: "0.05em" }}
                    className="text-xs">선택</span>
                </th>
                <th className={thTopInput + " min-w-[140px]"}>메모(진행)</th>
                <th className={thTopInput + " min-w-[160px]"}>상품명</th>
                <th className={thTopInput + " min-w-[130px]"}>옵션1</th>
                <th className={thTopInput + " min-w-[130px]"}>옵션2 (사이즈)</th>
                <th className={thTopInput + " min-w-[110px]"}>옵션3</th>
                <th className={thTopInput + " w-32"}>상시판매가</th>
                <th className={thTopInput + " w-32"}>판매가</th>
                <th className={thTopInput + " w-32"}>소비자가</th>
                <th className={thTopInput + " w-24"}>플랫폼</th>
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
                <th className={thBot + " w-32"}>공급사</th>
                <th className={thBot + " w-32 border-r-0"}>액션</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td colSpan={13} className="px-3 py-6 text-center text-xs text-gray-600">불러오는 중...</td></tr>
              ) : rows.length === 0 ? (
                <tr><td colSpan={13} className="px-3 py-6 text-center text-xs text-gray-400">등록된 상품이 없습니다. /samples 에서 [진행] 버튼으로 등록하세요.</td></tr>
              ) : rows.map(row => {
                // 한 상품 = 2 tr (사장 결정).
                //   ● 만 rowSpan=2. 나머지는 모두 위/아래 분할.
                //   위 줄 = 입력 가능 셀 (메모/상품명/옵션1·2·3). 사장 미지정 칸은 공란 (레이아웃만).
                //   아래 줄 = samples 에서 넘어온 정보 (공급 정보 read-only). 메모 위치는 공란.
                //   한 상품 단위 구분 = 아래 tr td 에 border-b-gray-200 진한 선.
                //   한 상품 안 위/아래 사이 = 옅은 선 (border-b-gray-100).
                // 위/아래 줄 높이 통일 = h-9 (36px). input/텍스트 모두 align-middle 로 가운데 정렬.
                const tdTop  = "border-r border-b border-gray-100 align-middle h-9";
                const tdBot  = "px-2 py-1.5 border-r border-b border-gray-200 text-xs text-gray-500 align-middle h-9";
                return (
                  <Fragment key={row._key}>
                    <tr className="hover:bg-gray-50/40">
                      <td rowSpan={2} className={td + " text-center border-b border-gray-200"}><SaveStatusDot status={saveState[row._key]} /></td>
                      <td rowSpan={2}
                        onClick={() => toggleSelect(row.id)}
                        className={td + " text-center border-b border-gray-200 cursor-pointer hover:bg-gray-50"}>
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
                      {/* 상품명: 위=consumer_name input */}
                      <td className={tdTop}>
                        <input {...cellProps(row, "consumer_name")} placeholder="소비자 상품명" className={inp + " font-medium"} />
                      </td>
                      {/* 옵션1/2/3: variant 단위 chip 인터페이스 (마이그 188). 통째 텍스트 수정 차단 */}
                      <td className={tdTop + " p-0"}>
                        <OptionChipCell productId={row.id} variants={row.variants} axis="color"
                          onChanged={() => tenant?.id && fetchItems(tenant.id)} />
                      </td>
                      <td className={tdTop + " p-0"}>
                        <OptionChipCell productId={row.id} variants={row.variants} axis="size"
                          onChanged={() => tenant?.id && fetchItems(tenant.id)} />
                      </td>
                      <td className={tdTop + " p-0"}>
                        <OptionChipCell productId={row.id} variants={row.variants} axis="option3"
                          onChanged={() => tenant?.id && fetchItems(tenant.id)} />
                      </td>
                      {/* 상시판매가 / 판매가 / 소비자가: 위=가격 input (콤마 포맷). 제조국/혼용율/공급사/액션 위=공란 */}
                      <td className={tdTop}>
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
                      <td className={tdTop}></td>
                      <td className={tdTop}></td>
                      {/* MD기능: 멘트 / 촬영 / AI. AI 는 Anthropic 연결 대기 — 비활성 회색.
                          w-32 컬럼에 text-xs 정상 크기 3 버튼 가로 한 줄. */}
                      <td className={tdTop + " border-r-0 text-center"}>
                        <div className="flex gap-1 justify-center">
                          <button onClick={() => setCommentModalRow(row)}
                            className={styles.btnSmall + " whitespace-nowrap"}>멘트</button>
                          <button onClick={() => setShootModalRow(row)}
                            className={styles.btnSmall + " whitespace-nowrap"}>촬영</button>
                          <button disabled title="AI 기능 준비 중"
                            className="px-2 py-0.5 text-xs border border-gray-300 text-gray-400 rounded cursor-not-allowed bg-gray-50 whitespace-nowrap">AI</button>
                        </div>
                      </td>
                    </tr>
                    <tr className="hover:bg-gray-50/40">
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
                      {/* 공급가/할인가/제조국/혼용율/공급사: 아래=samples 박제 read-only */}
                      <td className={tdBot + " text-right"}>{formatComma(row.wholesale_price) || "-"}</td>
                      <td className={tdBot + " text-right"}>{formatComma(row.wholesale_discount_price) || "-"}</td>
                      <td className={tdBot + " text-center"}>{row.country_of_origin || "-"}</td>
                      <td className={tdBot}>{row.material_composition || "-"}</td>
                      <td className={tdBot}>{row.wholesale_supplier || "-"}</td>
                      {/* 액션: 아래=[SIZE] [샘플로]. 사이즈는 회계 무관 메타데이터라 상시 활성 */}
                      <td className={tdBot + " text-center border-r-0"}>
                        <div className="flex gap-1 justify-center">
                          <button onClick={() => setSizeModalRow(row)} className={styles.btnSmall}>
                            SIZE
                          </button>
                          <button onClick={() => handleRevert(row.id)}
                            className={styles.btnSmallGhost + " whitespace-nowrap"}>
                            샘플로
                          </button>
                        </div>
                      </td>
                    </tr>
                  </Fragment>
                );
              })}
            </tbody>
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
          }}
          onClose={() => {
            setMemoModal(null);
            if (tenant?.id) fetchItems(tenant.id);
          }}
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
    </div>
  );
}
