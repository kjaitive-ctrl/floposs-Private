"use client";

// 주문(사입 발주) 시트 — 엑셀형 표. 상품명 고르면 도매상품명/거래처/단가/옵션이
// products 에서 자동 채워짐(스냅샷, 라이브 조인 아님) — 수량만 사용자가 입력.
// 거래처별로 묶어서 보여줌 — 그 구간을 스크린샷해서 카톡 등으로 수동 전송하는
// 용도(정식 발주 제출(order_notes)과는 별개, 가벼운 개인 시트). 마이그 231.
import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import { styles } from "@/common/styles";
import { formatComma, parseDigits } from "@/lib/format";
import ProductPickerCombobox from "@/components/purchase-order/ProductPickerCombobox";
import {
  type OrderItem, type OrderProduct, variantLabel,
  loadOrderProducts, loadOrderItems, addBlankOrderItems, updateOrderItem, deleteOrderItem,
} from "@/lib/purchaseOrder";

export default function OrderSheet({ tenantId }: { tenantId: string }) {
  const [products, setProducts] = useState<OrderProduct[]>([]);
  const [items, setItems] = useState<OrderItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);
  const [addErr, setAddErr] = useState<string | null>(null);

  const loadAll = useCallback(async () => {
    setLoading(true);
    const [prods, its] = await Promise.all([loadOrderProducts(tenantId), loadOrderItems(tenantId)]);
    setProducts(prods);
    setItems(its);
    setLoading(false);
  }, [tenantId]);
  useEffect(() => { loadAll(); }, [loadAll]);

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

  async function handleAddRows() {
    setAdding(true);
    setAddErr(null);
    const { items: created, error } = await addBlankOrderItems(tenantId, 5);
    setAdding(false);
    if (error) { setAddErr(error); return; }
    setItems(prev => [...prev, ...created]);
  }

  async function handleDelete(item: OrderItem) {
    if (!confirm(`"${item.product_name || "(이름 없음)"}" 행을 지울까요?`)) return;
    await deleteOrderItem(item.id);
    setItems(prev => prev.filter(i => i.id !== item.id));
  }

  // 거래처별로 묶기 — 편집 중 매 글자마다 재편성되면 안 되니(입력 중 그룹이
  // 계속 바뀌면 포커스가 튐) supplier_name 은 blur 시에만 로컬 state 갱신.
  const groups = useMemo(() => {
    const map = new Map<string, OrderItem[]>();
    for (const item of items) {
      const key = (item.supplier_name || "").trim() || "미지정";
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(item);
    }
    return Array.from(map.entries());
  }, [items]);

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
        <td className="px-1 py-1 w-24">
          <input value={formatComma(item.unit_price ?? "")} placeholder="0"
            onChange={e => patchLocal(item.id, { unit_price: Number(parseDigits(e.target.value) || "0") })}
            onBlur={() => updateOrderItem(item.id, { unit_price: item.unit_price ?? 0 })}
            className={styles.gridInput + " text-right"} />
        </td>
        <td className="px-1 py-1 w-20">
          <input value={formatComma(item.quantity ?? "")} placeholder="0"
            onChange={e => patchLocal(item.id, { quantity: Number(parseDigits(e.target.value) || "0") })}
            onBlur={() => updateOrderItem(item.id, { quantity: item.quantity ?? 0 })}
            className={styles.gridInput + " text-right"} />
        </td>
        <td className="px-2 py-1 w-24 text-right text-black font-medium">{formatComma(subtotal)}</td>
      </tr>
    );
  }

  return (
    <div className={styles.cardSm}>
      <div className={styles.sectionLabel}>주문 시트 ({items.length}행)</div>
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
                <th className={styles.th}>단가</th>
                <th className={styles.th}>수량</th>
                <th className={styles.th}>소계</th>
              </tr>
            </thead>
            <tbody>
              {items.length === 0 && (
                <tr><td colSpan={8} className="text-center text-gray-400 py-6 text-xs">아직 주문 행이 없어요 — 아래에서 추가하세요.</td></tr>
              )}
              {groups.map(([supplier, rows]) => (
                <Fragment key={supplier}>
                  <tr>
                    <td colSpan={8} className="px-2 pt-3 pb-1 text-sm font-bold text-black bg-gray-50">거래처: {supplier}</td>
                  </tr>
                  {rows.map(renderRow)}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="flex items-center gap-2">
        <button type="button" onClick={handleAddRows} disabled={adding} className={styles.btnSmallGhost}>
          {adding ? "추가 중…" : "+ 5줄 추가"}
        </button>
        {addErr && <span className="text-xs text-red-600">{addErr}</span>}
      </div>
    </div>
  );
}
