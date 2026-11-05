"use client";

// 주문(사입 발주) 시트 — 엑셀형 표. 상품명 고르면 도매상품명/거래처/단가/옵션이
// products 에서 자동 채워짐(스냅샷, 라이브 조인 아님) — 수량만 사용자가 입력.
// 거래처별로 묶어서 보여줌 — [이미지 복사]로 그 거래처 발주서를 카톡 등으로 수동 전송하는
// 용도(정식 발주 제출(order_notes)과는 별개, 가벼운 개인 시트). 마이그 231.
// 등록은 샘플 등록처럼 맨 위 입력 줄에서 — Enter 로 저장하면 거래처 묶음으로 들어가고 다시 입력 줄로.
import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { styles } from "@/common/styles";
import { formatComma, parseDigits, sanitizeFilename } from "@/lib/format";
import { supabase } from "@/lib/supabase";
import { copyOrderImage, renderOrderImage, type OrderImageRow } from "@/lib/orderImage";
import ProductPickerCombobox from "@/components/purchase-order/ProductPickerCombobox";
import {
  type OrderItem, type OrderProduct, variantLabel,
  loadOrderProducts, loadOrderItems, addOrderItem, updateOrderItem, deleteOrderItem,
} from "@/lib/purchaseOrder";

const EMPTY_DRAFT = {
  product_id: null as string | null,
  product_name: "",
  wholesale_name: "",
  supplier_name: "",
  variant_label: "",
  unit_price: 0,
  quantity: 1,
};

// 예전 "+5줄 추가"로 생긴 내용 없는 행은 표에 보여주지 않음.
function hasContent(item: OrderItem) {
  return !!(item.product_id || item.product_name?.trim() || item.wholesale_name?.trim()
    || item.supplier_name?.trim() || item.variant_label?.trim() || item.quantity);
}

// 등록 시각을 한국 날짜(YYYY-MM-DD)로 — 날짜별 보기의 기준.
function kstDate(value: string | Date) {
  return new Date(value).toLocaleDateString("sv-SE", { timeZone: "Asia/Seoul" });
}

function formatDateLabel(date: string) {
  return new Date(`${date}T00:00:00+09:00`).toLocaleDateString("ko-KR", {
    timeZone: "Asia/Seoul", month: "long", day: "numeric", weekday: "short",
  });
}

function focusCell(id: string) {
  setTimeout(() => document.getElementById(id)?.focus(), 50);
}

export default function OrderSheet({ tenantId }: { tenantId: string }) {
  const [products, setProducts] = useState<OrderProduct[]>([]);
  const [items, setItems] = useState<OrderItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [draft, setDraft] = useState(EMPTY_DRAFT);
  const [draftErr, setDraftErr] = useState<string | null>(null);
  const savingDraft = useRef(false);
  const [today, setToday] = useState(() => kstDate(new Date()));
  const [selectedDate, setSelectedDate] = useState(today);
  const [storeName, setStoreName] = useState("");
  const [companyName, setCompanyName] = useState("");
  // 거래처별 복사 결과 문구 (잠시 표시)
  const [copyStatus, setCopyStatus] = useState<{ supplier: string; text: string; error?: boolean } | null>(null);
  const copyStatusTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const loadAll = useCallback(async () => {
    setLoading(true);
    const [prods, its, tenantRes] = await Promise.all([
      loadOrderProducts(tenantId),
      loadOrderItems(tenantId),
      supabase.from("tenants").select("store_name, company_name").eq("id", tenantId).maybeSingle(),
    ]);
    setProducts(prods);
    setItems(its.filter(hasContent));
    setStoreName(tenantRes.data?.store_name ?? "");
    setCompanyName(tenantRes.data?.company_name ?? "");
    setLoading(false);
  }, [tenantId]);
  useEffect(() => { loadAll(); }, [loadAll]);

  useEffect(() => () => {
    if (copyStatusTimer.current) clearTimeout(copyStatusTimer.current);
  }, []);

  function patchLocal(id: string, patch: Partial<OrderItem>) {
    setItems(prev => prev.map(i => i.id === id ? { ...i, ...patch } : i));
  }

  function handlePick(item: OrderItem, product: OrderProduct) {
    const patch = {
      product_id: product.id,
      product_name: product.consumer_name || product.wholesale_name || "",
      wholesale_name: product.wholesale_name || "",
      supplier_name: product.wholesale_supplier || "",
      unit_price: product.effective_price || 0,
      variant_label: "",
    };
    patchLocal(item.id, patch);
    updateOrderItem(item.id, patch);
  }

  function handleDraftPick(product: OrderProduct) {
    setDraft({
      ...EMPTY_DRAFT,
      product_id: product.id,
      product_name: product.consumer_name || product.wholesale_name || "",
      wholesale_name: product.wholesale_name || "",
      supplier_name: (product.wholesale_supplier || "").trim(),
      unit_price: product.effective_price || 0,
      quantity: draft.quantity,
    });
    setDraftErr(null);
    focusCell(product.variants.some(v => variantLabel(v)) ? "po-draft-option" : "po-draft-quantity");
  }

  // 고른 상품의 이름을 고치면 등록 안 된 상품으로 보고 자동으로 채운 값을 비움.
  function handleDraftNameChange(text: string) {
    setDraft(d => d.product_id
      ? { ...EMPTY_DRAFT, product_name: text, quantity: d.quantity }
      : { ...d, product_name: text });
  }

  async function submitDraft() {
    if (savingDraft.current) return;
    const name = draft.product_name.trim();
    const wholesaleName = draft.wholesale_name.trim();
    if (!name && !wholesaleName) { focusCell("po-draft-name"); return; }
    savingDraft.current = true;
    setDraftErr(null);
    const { item, error } = await addOrderItem(tenantId, {
      product_id: draft.product_id,
      product_name: name || null,
      wholesale_name: wholesaleName || null,
      supplier_name: draft.supplier_name.trim() || null,
      variant_label: draft.variant_label || null,
      unit_price: draft.unit_price,
      quantity: draft.quantity,
    });
    savingDraft.current = false;
    if (error || !item) { setDraftErr(error ?? "등록 실패"); return; }
    setItems(prev => [...prev, item]);
    // 지난 날짜를 보다가 등록해도 방금 넣은 줄이 보이도록 오늘로 돌아옴
    const createdDate = kstDate(item.created_at);
    setToday(createdDate);
    setSelectedDate(createdDate);
    setDraft(EMPTY_DRAFT);
    focusCell("po-draft-name");
  }

  function handleDraftEnter(e: KeyboardEvent<HTMLElement>) {
    if (e.key !== "Enter" || e.nativeEvent.isComposing || e.keyCode === 229) return;
    e.preventDefault();
    submitDraft();
  }

  async function handleDelete(item: OrderItem) {
    if (!confirm(`"${item.product_name || "(이름 없음)"}" 행을 지울까요?`)) return;
    await deleteOrderItem(item.id);
    setItems(prev => prev.filter(i => i.id !== item.id));
  }

  // 거래처별로 묶기 — 편집 중 매 글자마다 재편성되면 안 되니(입력 중 그룹이
  // 계속 바뀌면 포커스가 튐) supplier_name 은 blur 시에만 로컬 state 갱신.
  const visibleItems = useMemo(
    () => items.filter(item => kstDate(item.created_at) === selectedDate),
    [items, selectedDate]
  );
  const groups = useMemo(() => {
    const map = new Map<string, OrderItem[]>();
    for (const item of visibleItems) {
      const key = (item.supplier_name || "").trim() || "미지정";
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(item);
    }
    return Array.from(map.entries());
  }, [visibleItems]);

  // ◀ ▶ 는 주문이 있는 날짜끼리만 이동 — 오늘은 비어 있어도 항상 포함.
  const dates = useMemo(
    () => Array.from(new Set([...items.map(item => kstDate(item.created_at)), today])).sort(),
    [items, today]
  );
  const dateIndex = dates.indexOf(selectedDate);
  const prevDate = dateIndex > 0 ? dates[dateIndex - 1] : null;
  const nextDate = dateIndex >= 0 && dateIndex < dates.length - 1 ? dates[dateIndex + 1] : null;

  // 옵션 라벨("연밤 / FREE")을 상품 옵션과 대조해 사입옵션·사이즈 칸으로 나눔.
  // 직접 입력한 옵션은 나눌 수 없어 사입옵션 칸에 그대로 표시.
  function toImageRow(item: OrderItem): OrderImageRow {
    const label = item.variant_label ?? "";
    const variant = products.find(p => p.id === item.product_id)?.variants.find(v => variantLabel(v) === label);
    return {
      name: item.wholesale_name || item.product_name || "",
      option: variant ? [variant.color, variant.option3].filter(Boolean).join(" / ") : label,
      size: variant?.size ?? "",
      supplier: item.supplier_name ?? "",
      quantity: item.quantity,
    };
  }

  // 클릭 직후 동기로 복사를 시작해야 브라우저가 사용자 동작으로 인정함 (await 전에 렌더 시작).
  async function handleCopyImage(supplier: string, rows: OrderItem[]) {
    const targets = rows.filter(i => i.quantity > 0 && (i.wholesale_name || i.product_name));
    if (targets.length === 0) return;
    const store = storeName || companyName;
    const company = companyName.replace(/^\(주\)\s*/, "주식회사 ");
    const image = renderOrderImage(`${store}/주문`, store === companyName ? "" : `(${company})`, targets.map(toImageRow));
    const noOption = targets.filter(i => !i.variant_label).length;
    let status: { supplier: string; text: string; error?: boolean };
    try {
      const result = await copyOrderImage(image, `${sanitizeFilename(`${store}_주문_${supplier}`)}.png`);
      const base = result === "copied" ? `복사됨 ${targets.length}줄 — 카톡에 붙여넣으세요` : `복사가 막혀 파일로 내려받았습니다 (${targets.length}줄)`;
      status = { supplier, text: noOption > 0 ? `${base} · 옵션 없는 줄 ${noOption}개` : base };
    } catch (e) {
      status = { supplier, text: `이미지 복사 실패: ${e instanceof Error ? e.message : String(e)}`, error: true };
    }
    setCopyStatus(status);
    if (copyStatusTimer.current) clearTimeout(copyStatusTimer.current);
    copyStatusTimer.current = setTimeout(() => setCopyStatus(null), 4000);
  }

  function renderDraftRow() {
    const options = Array.from(new Set(
      (products.find(p => p.id === draft.product_id)?.variants ?? []).map(variantLabel).filter(Boolean)
    ));
    return (
      <tr className="bg-amber-50">
        <td className="px-1 py-1 text-center text-gray-400">+</td>
        <td className="px-1 py-1 min-w-[140px]">
          <ProductPickerCombobox
            id="po-draft-name"
            products={products}
            value={draft.product_name}
            onTextChange={handleDraftNameChange}
            onPick={handleDraftPick}
            onKeyDownNav={handleDraftEnter}
          />
        </td>
        <td className="px-1 py-1 min-w-[140px]">
          <input value={draft.wholesale_name} placeholder="도매상품명"
            onChange={e => setDraft(d => ({ ...d, wholesale_name: e.target.value }))}
            onKeyDown={handleDraftEnter}
            className={styles.gridInput} />
        </td>
        <td className="px-1 py-1 min-w-[100px]">
          <input value={draft.supplier_name} placeholder="거래처"
            onChange={e => setDraft(d => ({ ...d, supplier_name: e.target.value }))}
            onKeyDown={handleDraftEnter}
            className={styles.gridInput} />
        </td>
        <td className="px-1 py-1 min-w-[100px]">
          {options.length > 0 ? (
            <select id="po-draft-option" value={draft.variant_label}
              onChange={e => setDraft(d => ({ ...d, variant_label: e.target.value }))}
              onKeyDown={handleDraftEnter}
              className={styles.gridInput}>
              <option value="">선택</option>
              {options.map(o => <option key={o} value={o}>{o}</option>)}
            </select>
          ) : (
            <input id="po-draft-option" value={draft.variant_label} placeholder="옵션"
              onChange={e => setDraft(d => ({ ...d, variant_label: e.target.value }))}
              onKeyDown={handleDraftEnter}
              className={styles.gridInput} />
          )}
        </td>
        <td className="px-1 py-1 w-20">
          <input id="po-draft-quantity" value={formatComma(draft.quantity)} placeholder="0"
            onFocus={e => e.target.select()}
            onChange={e => setDraft(d => ({ ...d, quantity: Number(parseDigits(e.target.value) || "0") }))}
            onKeyDown={handleDraftEnter}
            className={styles.gridInput + " text-right"} />
        </td>
        <td className="px-1 py-1 w-24">
          <input value={formatComma(draft.unit_price)} placeholder="0"
            onChange={e => setDraft(d => ({ ...d, unit_price: Number(parseDigits(e.target.value) || "0") }))}
            onKeyDown={handleDraftEnter}
            className={styles.gridInput + " text-right"} />
        </td>
        <td className="px-2 py-1 w-24 text-right text-black font-medium">{formatComma(draft.unit_price * draft.quantity)}</td>
      </tr>
    );
  }

  function renderRow(item: OrderItem) {
    const product = products.find(p => p.id === item.product_id);
    const variants = product?.variants ?? [];
    const options = Array.from(new Set(variants.map(variantLabel).filter(Boolean)));
    const subtotal = (item.unit_price || 0) * (item.quantity || 0);

    return (
      <tr key={item.id} className={styles.tr}>
        <td className="px-1 py-1 text-center">
          <button type="button" onClick={() => handleDelete(item)} className="text-gray-300 hover:text-red-600" title="이 행 삭제">×</button>
        </td>
        <td className="px-1 py-1 min-w-[140px]">
          <ProductPickerCombobox
            id={`po-${item.id}-name`}
            products={products}
            value={item.product_name ?? ""}
            onTextChange={text => patchLocal(item.id, { product_name: text })}
            onPick={product => handlePick(item, product)}
            onBlurCommit={() => updateOrderItem(item.id, { product_name: item.product_name })}
          />
        </td>
        <td className="px-1 py-1 min-w-[140px]">
          <input defaultValue={item.wholesale_name ?? ""} placeholder="도매상품명"
            onBlur={e => { const v = e.target.value; patchLocal(item.id, { wholesale_name: v }); updateOrderItem(item.id, { wholesale_name: v || null }); }}
            className={styles.gridInput} />
        </td>
        <td className="px-1 py-1 min-w-[100px]">
          <input defaultValue={item.supplier_name ?? ""} placeholder="거래처"
            onBlur={e => { const v = e.target.value; patchLocal(item.id, { supplier_name: v }); updateOrderItem(item.id, { supplier_name: v || null }); }}
            className={styles.gridInput} />
        </td>
        <td className="px-1 py-1 min-w-[100px]">
          {options.length > 0 ? (
            <select value={item.variant_label ?? ""}
              onChange={e => { const v = e.target.value; patchLocal(item.id, { variant_label: v }); updateOrderItem(item.id, { variant_label: v || null }); }}
              className={styles.gridInput}>
              <option value="">선택</option>
              {options.map(o => <option key={o} value={o}>{o}</option>)}
            </select>
          ) : (
            <input defaultValue={item.variant_label ?? ""} placeholder="옵션"
              onBlur={e => { const v = e.target.value; patchLocal(item.id, { variant_label: v }); updateOrderItem(item.id, { variant_label: v || null }); }}
              className={styles.gridInput} />
          )}
        </td>
        <td className="px-1 py-1 w-20">
          <input value={formatComma(item.quantity ?? "")} placeholder="0"
            onFocus={e => e.target.select()}
            onChange={e => patchLocal(item.id, { quantity: Number(parseDigits(e.target.value) || "0") })}
            onBlur={() => updateOrderItem(item.id, { quantity: item.quantity ?? 0 })}
            className={styles.gridInput + " text-right"} />
        </td>
        <td className="px-1 py-1 w-24">
          <input value={formatComma(item.unit_price ?? "")} placeholder="0"
            onChange={e => patchLocal(item.id, { unit_price: Number(parseDigits(e.target.value) || "0") })}
            onBlur={() => updateOrderItem(item.id, { unit_price: item.unit_price ?? 0 })}
            className={styles.gridInput + " text-right"} />
        </td>
        <td className="px-2 py-1 w-24 text-right text-black font-medium">{formatComma(subtotal)}</td>
      </tr>
    );
  }

  return (
    <div className={styles.cardSm}>
      <div className="flex items-center gap-2 mb-2">
        <button type="button" disabled={!prevDate} onClick={() => prevDate && setSelectedDate(prevDate)}
          title="이전 주문 날짜" className={styles.btnSmall + " bg-white disabled:opacity-30 disabled:cursor-not-allowed"}>◀</button>
        <span className="text-sm font-bold text-black whitespace-nowrap">{formatDateLabel(selectedDate)}</span>
        <button type="button" disabled={!nextDate} onClick={() => nextDate && setSelectedDate(nextDate)}
          title="다음 주문 날짜" className={styles.btnSmall + " bg-white disabled:opacity-30 disabled:cursor-not-allowed"}>▶</button>
        {selectedDate !== today && (
          <button type="button" onClick={() => setSelectedDate(today)} className={styles.btnSmallGhost}>오늘</button>
        )}
        <span className="text-xs text-gray-500">{visibleItems.length}행</span>
      </div>
      {loading ? (
        <div className="text-xs text-gray-400">불러오는 중…</div>
      ) : (
        <div className="overflow-x-auto border border-gray-200 rounded-lg mb-3">
          <table className="w-full text-xs border-collapse">
            <thead>
              <tr className="bg-gray-50">
                <th className={styles.th + " w-8"}>관리</th>
                <th className={styles.thLeft}>상품명</th>
                <th className={styles.thLeft}>도매상품명</th>
                <th className={styles.thLeft}>거래처</th>
                <th className={styles.th}>옵션</th>
                <th className={styles.th}>수량</th>
                <th className={styles.th}>단가</th>
                <th className={styles.th}>소계</th>
              </tr>
            </thead>
            <tbody>
              {renderDraftRow()}
              {groups.map(([supplier, rows]) => {
                const copyable = rows.filter(i => i.quantity > 0 && (i.wholesale_name || i.product_name)).length;
                return (
                  <Fragment key={supplier}>
                    <tr>
                      <td colSpan={8} className="px-2 pt-3 pb-1 bg-gray-50">
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-bold text-black">거래처: {supplier}</span>
                          <button type="button" disabled={copyable === 0}
                            onClick={() => handleCopyImage(supplier, rows)}
                            title={copyable === 0 ? "수량을 입력하면 복사할 수 있습니다" : "수량이 있는 줄만 이미지로 복사 (단가 제외)"}
                            className={styles.btnSmall + " whitespace-nowrap bg-white disabled:opacity-30 disabled:cursor-not-allowed"}>
                            이미지 복사
                          </button>
                          {copyStatus?.supplier === supplier && (
                            <span role="status" className={"text-xs " + (copyStatus.error ? "text-red-600" : "text-emerald-700")}>{copyStatus.text}</span>
                          )}
                        </div>
                      </td>
                    </tr>
                    {rows.map(renderRow)}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <div className="text-xs">
        {draftErr
          ? <span className="text-red-600">{draftErr}</span>
          : <span className="text-gray-400">맨 위 줄에 입력하고 Enter를 누르면 오늘 날짜로 등록됩니다.</span>}
      </div>
    </div>
  );
}
