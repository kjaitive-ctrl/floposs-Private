"use client";

// 주문(사입 발주) 시트 — 엑셀형 표. 상품명 고르면 도매상품명/거래처/단가/옵션이
// products 에서 자동 채워짐(스냅샷, 라이브 조인 아님) — 수량만 사용자가 입력.
// 거래처별로 묶어서 보여줌 — [이미지 복사]로 그 거래처 발주서를 카톡 등으로 수동 전송하는
// 용도(정식 발주 제출(order_notes)과는 별개, 가벼운 개인 시트). 마이그 231.
// 등록은 샘플 등록처럼 맨 위 입력 줄에서 — Enter 로 저장하면 거래처 묶음으로 들어가고 다시 입력 줄로.
// 줄마다 반품·교환·수거완료·메모·보류(마이그 237) — 표에서만 관리하고 이미지에는 나가지 않음.
// 보류·반품·교환 줄은 거래처에 다시 주문되면 안 되므로 이미지에서 줄째 뺌.
import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { styles } from "@/common/styles";
import { formatComma, parseDigits, sanitizeFilename } from "@/lib/format";
import { supabase } from "@/lib/supabase";
import { copyOrderImage, renderOrderImage, type OrderImageRow } from "@/lib/orderImage";
import ProductPickerCombobox from "@/components/purchase-order/ProductPickerCombobox";
import {
  type OrderClaimType, type OrderItem, type OrderItemPatch, type OrderProduct, variantLabel,
  loadOrderProducts, loadOrderItems, addOrderItem, updateOrderItem, deleteOrderItem, moveOrderItemToToday,
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

// 이미지로 거래처에 보낼 수 있는 줄.
function isOrderable(item: OrderItem) {
  return item.quantity > 0 && !!(item.wholesale_name || item.product_name) && !item.held_at && !item.claim_type;
}

function formatShortDate(value: string) {
  return new Date(value).toLocaleDateString("ko-KR", { timeZone: "Asia/Seoul", month: "numeric", day: "numeric" });
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
  // 표가 길면 아래쪽은 화면 밖이라 등록 결과는 표 위 날짜 줄에 표시.
  const [draftMsg, setDraftMsg] = useState<{ text: string; error?: boolean } | null>(null);
  const [statusErr, setStatusErr] = useState<string | null>(null);
  const savingDraft = useRef(false);
  const [saving, setSaving] = useState(false);
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
    setDraftMsg(null);
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
    setSaving(true);
    setDraftMsg(null);
    try {
      const { item, error } = await addOrderItem(tenantId, {
        product_id: draft.product_id,
        product_name: name || null,
        wholesale_name: wholesaleName || null,
        supplier_name: draft.supplier_name.trim() || null,
        variant_label: draft.variant_label || null,
        unit_price: draft.unit_price,
        quantity: draft.quantity,
      });
      if (error || !item) { setDraftMsg({ text: `등록 실패: ${error ?? "저장된 줄을 받지 못했습니다"}`, error: true }); return; }
      setItems(prev => [...prev, item]);
      // 지난 날짜를 보다가 등록해도 방금 넣은 줄이 보이도록 오늘로 돌아옴
      const createdDate = kstDate(item.created_at);
      setToday(createdDate);
      setSelectedDate(createdDate);
      setDraft(EMPTY_DRAFT);
      // 새 거래처 묶음은 표 맨 아래에 생겨 안 보일 수 있으니 어디로 들어갔는지 알려줌
      setDraftMsg({ text: `등록됨: ${name || wholesaleName} → 거래처 ${item.supplier_name?.trim() || "미지정"}` });
      focusCell("po-draft-name");
    } catch (e) {
      setDraftMsg({ text: `등록 실패: ${e instanceof Error ? e.message : String(e)}`, error: true });
    } finally {
      savingDraft.current = false;
      setSaving(false);
    }
  }

  function handleDraftEnter(e: KeyboardEvent<HTMLElement>) {
    if (e.key !== "Enter" || e.nativeEvent.isComposing || e.keyCode === 229) return;
    e.preventDefault();
    submitDraft();
  }

  // 옵션 고르기 칸은 글자 조합이 없으니 한글 입력 상태(key=Process, 229)여도 Enter 로 등록.
  function handleDraftSelectEnter(e: KeyboardEvent<HTMLElement>) {
    if (e.key !== "Enter" && e.code !== "Enter" && e.code !== "NumpadEnter") return;
    e.preventDefault();
    submitDraft();
  }

  async function handleDelete(item: OrderItem) {
    if (!confirm(`"${item.product_name || "(이름 없음)"}" 행을 지울까요?`)) return;
    setStatusErr(null);
    const error = await deleteOrderItem(item.id);
    if (error) { setStatusErr(`삭제 실패: ${error}`); return; }
    setItems(prev => prev.filter(i => i.id !== item.id));
  }

  // 넘어온 보류 줄을 오늘 주문으로 — 보류가 풀리고 오늘 날짜의 거래처 묶음으로 들어가 이미지 복사에 포함됨.
  async function handleMoveToToday(item: OrderItem) {
    setStatusErr(null);
    const { created_at, error } = await moveOrderItemToToday(item.id);
    if (error || !created_at) { setStatusErr(`오늘로 옮기기 실패: ${error ?? "알 수 없는 오류"}`); return; }
    patchLocal(item.id, { created_at, held_at: null });
    const movedDate = kstDate(created_at);
    setToday(movedDate);
    setSelectedDate(movedDate);
    setDraftMsg({ text: `오늘 주문으로 옮김: ${item.product_name || item.wholesale_name || "(이름 없음)"} (${formatShortDate(item.created_at)} 주문분)` });
  }

  // 반품·교환·수거·메모·보류 저장 — 실패하면 화면을 되돌리고 알려줌.
  async function saveStatus(item: OrderItem, patch: OrderItemPatch) {
    const previous = Object.fromEntries(
      Object.keys(patch).map(key => [key, item[key as keyof OrderItem] ?? null])
    ) as OrderItemPatch;
    patchLocal(item.id, patch);
    setStatusErr(null);
    const error = await updateOrderItem(item.id, patch);
    if (error) {
      patchLocal(item.id, previous);
      setStatusErr(`저장 실패: ${error}`);
    }
  }

  // 같은 버튼을 다시 누르면 해제. 수량은 1부터 — 여러 개인 줄은 칸에서 고침.
  function handleClaim(item: OrderItem, type: OrderClaimType) {
    if (item.claim_type !== type) {
      saveStatus(item, { claim_type: type, claim_quantity: item.claim_quantity ?? 1 });
      return;
    }
    if (item.claim_collected_at && !confirm("수거완료 기록도 함께 지워집니다. 해제할까요?")) return;
    saveStatus(item, { claim_type: null, claim_quantity: null, claim_collected_at: null });
  }

  function handleClaimQuantityBlur(item: OrderItem) {
    const quantity = Math.min(Math.max(item.claim_quantity ?? 1, 1), Math.max(item.quantity, 1));
    saveStatus(item, { claim_quantity: quantity });
  }

  // 주문 수량을 줄이면 반품·교환 수량이 넘치지 않게 같이 맞춤.
  function handleQuantityBlur(item: OrderItem) {
    const quantity = item.quantity ?? 0;
    const maxClaim = Math.max(quantity, 1);
    if (item.claim_quantity && item.claim_quantity > maxClaim) {
      saveStatus(item, { quantity, claim_quantity: maxClaim });
    } else {
      updateOrderItem(item.id, { quantity });
    }
  }

  // 거래처별로 묶기 — 편집 중 매 글자마다 재편성되면 안 되니(입력 중 그룹이
  // 계속 바뀌면 포커스가 튐) supplier_name 은 blur 시에만 로컬 state 갱신.
  const dayItems = useMemo(
    () => items.filter(item => kstDate(item.created_at) === selectedDate),
    [items, selectedDate]
  );
  // 이전 날짜에서 보류해 둔 줄 — 해제할 때까지 이후 날짜마다 맨 위에 표시.
  const carriedItems = useMemo(
    () => items.filter(item => item.held_at
      && kstDate(item.created_at) < selectedDate
      && kstDate(item.held_at) <= selectedDate),
    [items, selectedDate]
  );
  const groups = useMemo(() => {
    const map = new Map<string, OrderItem[]>();
    for (const item of dayItems) {
      const key = (item.supplier_name || "").trim() || "미지정";
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(item);
    }
    return Array.from(map.entries());
  }, [dayItems]);

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
    const targets = rows.filter(isOrderable);
    if (targets.length === 0) return;
    const excluded = rows.filter(i => i.held_at || i.claim_type).length;
    const store = storeName || companyName;
    const company = companyName.replace(/^\(주\)\s*/, "주식회사 ");
    const image = renderOrderImage(`${store}/주문`, store === companyName ? "" : `(${company})`, targets.map(toImageRow));
    const noOption = targets.filter(i => !i.variant_label).length;
    let status: { supplier: string; text: string; error?: boolean };
    try {
      const result = await copyOrderImage(image, `${sanitizeFilename(`${store}_주문_${supplier}`)}.png`);
      const base = result === "copied" ? `복사됨 ${targets.length}줄 — 카톡에 붙여넣으세요` : `복사가 막혀 파일로 내려받았습니다 (${targets.length}줄)`;
      const notes = [
        noOption > 0 ? `옵션 없는 줄 ${noOption}개` : "",
        excluded > 0 ? `보류·반품·교환 ${excluded}줄 제외` : "",
      ].filter(Boolean);
      status = { supplier, text: [base, ...notes].join(" · ") };
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
        <td className="px-1 py-1 text-center">
          <button type="button" disabled={saving} onClick={submitDraft} title="이 줄 등록 (Enter)"
            className={styles.btnSmall + " whitespace-nowrap bg-white disabled:opacity-30 disabled:cursor-not-allowed"}>
            {saving ? "저장 중" : "등록"}
          </button>
        </td>
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
              onKeyDown={handleDraftSelectEnter}
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
        <td colSpan={4} />
      </tr>
    );
  }

  function renderRow(item: OrderItem) {
    const product = products.find(p => p.id === item.product_id);
    const variants = product?.variants ?? [];
    const options = Array.from(new Set(variants.map(variantLabel).filter(Boolean)));
    const subtotal = (item.unit_price || 0) * (item.quantity || 0);
    const createdDate = kstDate(item.created_at);

    return (
      <tr key={item.id} className={styles.tr + (item.held_at ? " bg-orange-50" : "")}>
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
            onBlur={() => handleQuantityBlur(item)}
            className={styles.gridInput + " text-right"} />
        </td>
        <td className="px-1 py-1 w-24">
          <input value={formatComma(item.unit_price ?? "")} placeholder="0"
            onChange={e => patchLocal(item.id, { unit_price: Number(parseDigits(e.target.value) || "0") })}
            onBlur={() => updateOrderItem(item.id, { unit_price: item.unit_price ?? 0 })}
            className={styles.gridInput + " text-right"} />
        </td>
        <td className="px-2 py-1 w-24 text-right text-black font-medium">{formatComma(subtotal)}</td>
        <td className="px-2 py-1 border-l border-gray-200 whitespace-nowrap">
          <div className="flex items-center gap-1">
            <button type="button" disabled={item.quantity <= 0} onClick={() => handleClaim(item, "return")}
              title={item.quantity <= 0 ? "수량이 있는 줄만 표시할 수 있습니다" : undefined}
              className={(item.claim_type === "return" ? styles.btnSmallRed : styles.btnSmallGhost) + " disabled:opacity-30 disabled:cursor-not-allowed"}>반품</button>
            <button type="button" disabled={item.quantity <= 0} onClick={() => handleClaim(item, "exchange")}
              title={item.quantity <= 0 ? "수량이 있는 줄만 표시할 수 있습니다" : undefined}
              className={(item.claim_type === "exchange" ? styles.btnSmallBlue : styles.btnSmallGhost) + " disabled:opacity-30 disabled:cursor-not-allowed"}>교환</button>
            {item.claim_type && item.quantity > 1 && (
              <span className="flex items-center gap-0.5 ml-1 text-gray-500">
                <input value={formatComma(item.claim_quantity ?? "")} aria-label="반품·교환 수량"
                  onFocus={e => e.target.select()}
                  onChange={e => patchLocal(item.id, { claim_quantity: Number(parseDigits(e.target.value) || "0") })}
                  onBlur={() => handleClaimQuantityBlur(item)}
                  className="w-8 px-1 py-0.5 text-xs text-right text-black border border-gray-300 rounded" />
                /{item.quantity}
              </span>
            )}
          </div>
        </td>
        <td className="px-2 py-1 whitespace-nowrap">
          {item.claim_type ? (
            <button type="button"
              onClick={() => saveStatus(item, { claim_collected_at: item.claim_collected_at ? null : new Date().toISOString() })}
              title={item.claim_collected_at ? "누르면 수거 전으로 되돌림" : "고객에게서 수거했으면 누르세요"}
              className={item.claim_collected_at ? styles.btnSmallGreen : styles.btnSmall + " bg-white"}>
              {item.claim_collected_at ? `수거완료 ${formatShortDate(item.claim_collected_at)}` : "수거완료"}
            </button>
          ) : (
            <span className="text-gray-300">-</span>
          )}
        </td>
        <td className="px-1 py-1 min-w-[200px]">
          <input defaultValue={item.memo ?? ""} placeholder="메모" title={item.memo ?? undefined}
            onKeyDown={e => { if (e.key === "Enter" && !e.nativeEvent.isComposing && e.keyCode !== 229) e.currentTarget.blur(); }}
            onBlur={e => { const v = e.target.value.trim(); if (v !== (item.memo ?? "")) saveStatus(item, { memo: v || null }); }}
            className={styles.gridInput} />
        </td>
        <td className="px-2 py-1 whitespace-nowrap">
          <div className="flex items-center gap-1">
            <button type="button"
              onClick={() => saveStatus(item, { held_at: item.held_at ? null : new Date().toISOString() })}
              title={item.held_at ? "누르면 보류 해제" : "해제할 때까지 다음 날짜에도 계속 보입니다"}
              className={item.held_at ? styles.btnSmallOrange : styles.btnSmallGhost}>
              보류
            </button>
            {createdDate !== selectedDate && (
              <span className="text-gray-500">{formatShortDate(item.created_at)} 주문</span>
            )}
            {item.held_at && createdDate < selectedDate && (
              <>
                <button type="button" onClick={() => handleMoveToToday(item)}
                  title="보류를 풀고 오늘 주문으로 옮깁니다 (이미지 복사에 포함)"
                  className={styles.btnSmall + " whitespace-nowrap bg-white"}>오늘 주문으로</button>
                <button type="button" onClick={() => handleDelete(item)}
                  title="이 줄을 지웁니다"
                  className={styles.btnSmallGhost + " hover:text-red-600"}>삭제</button>
              </>
            )}
          </div>
        </td>
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
        <span className="text-xs text-gray-500">
          {dayItems.length}행{carriedItems.length > 0 && ` · 넘어온 보류 ${carriedItems.length}건`}
        </span>
        {statusErr && <span role="alert" className="text-xs text-red-600">{statusErr}</span>}
        {draftMsg && <span role="status" className={"text-xs " + (draftMsg.error ? "text-red-600" : "text-emerald-700")}>{draftMsg.text}</span>}
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
                <th className={styles.thLeft + " border-l border-gray-200"}>반품·교환</th>
                <th className={styles.thLeft}>수거</th>
                <th className={styles.thLeft}>메모</th>
                <th className={styles.thLeft}>보류</th>
              </tr>
            </thead>
            <tbody>
              {renderDraftRow()}
              {carriedItems.length > 0 && (
                <>
                  <tr>
                    <td colSpan={12} className="px-2 pt-3 pb-1 bg-orange-50">
                      <span className="text-sm font-bold text-black">보류: 이전 날짜에서 넘어온 주문</span>
                    </td>
                  </tr>
                  {carriedItems.map(renderRow)}
                </>
              )}
              {groups.map(([supplier, rows]) => {
                const copyable = rows.filter(isOrderable).length;
                return (
                  <Fragment key={supplier}>
                    <tr>
                      <td colSpan={12} className="px-2 pt-3 pb-1 bg-gray-50">
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-bold text-black">거래처: {supplier}</span>
                          <button type="button" disabled={copyable === 0}
                            onClick={() => handleCopyImage(supplier, rows)}
                            title={copyable === 0 ? "복사할 줄이 없습니다 (수량 없음 또는 보류·반품·교환)" : "수량이 있는 줄만 이미지로 복사 (단가·메모 제외, 보류·반품·교환 줄 제외)"}
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
      <div className="text-xs text-gray-400">맨 위 줄에 입력하고 Enter 또는 [등록]을 누르면 오늘 날짜로 등록됩니다.</div>
    </div>
  );
}
