"use client";

import { useMemo, useState } from "react";
import { styles } from "@/common/styles";
import type { PortalProduct, SubmitItem } from "@/lib/orderPortal";

interface Props {
  products: PortalProduct[];
  value: Map<string, number>; // variant_id → qty
  onChange: (next: Map<string, number>) => void;
}

// 엑셀형 그리드. 행 = 상품 × 옵션. 수량만 입력. 단가 노출 X.
export default function ProductGrid({ products, value, onChange }: Props) {
  const [q, setQ] = useState("");

  const rows = useMemo(() => {
    const flat: { product: PortalProduct; variant: PortalProduct["variants"][number] }[] = [];
    const term = q.trim().toLowerCase();
    for (const p of products) {
      const match =
        !term ||
        p.product_name.toLowerCase().includes(term) ||
        (p.product_code ?? "").toLowerCase().includes(term);
      if (!match) continue;
      if (p.variants.length === 0) continue;
      for (const v of p.variants) {
        flat.push({ product: p, variant: v });
      }
    }
    return flat;
  }, [products, q]);

  function setQty(variantId: string, qty: number) {
    const next = new Map(value);
    if (qty <= 0 || !Number.isFinite(qty)) next.delete(variantId);
    else next.set(variantId, Math.floor(qty));
    onChange(next);
  }

  const totalRows = rows.length;
  const filledRows = rows.filter((r) => (value.get(r.variant.variant_id) ?? 0) > 0).length;

  return (
    <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
      <div className="px-4 py-3 border-b border-gray-200 flex items-center gap-3">
        <input
          className={`${styles.filterInput} flex-1`}
          type="search"
          placeholder="상품명 또는 코드로 필터"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <span className="text-xs text-gray-500 whitespace-nowrap">
          {filledRows} / {totalRows} 행
        </span>
      </div>

      <div className="max-h-[60vh] overflow-y-auto">
        <table className="w-full text-xs">
          <thead className="sticky top-0 bg-gray-50 border-b border-gray-200">
            <tr>
              <th className={styles.thLeft}>내 상품명</th>
              <th className={styles.th}>내 옵션</th>
              <th className={styles.thLeft}>공급사 상품명</th>
              <th className={styles.th}>공급사 옵션</th>
              <th className={styles.th} style={{ width: 90 }}>단가</th>
              <th className={styles.th} style={{ width: 100 }}>
                수량
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={6} className="text-center text-gray-400 py-8">
                  표시할 상품이 없습니다.
                </td>
              </tr>
            ) : (
              rows.map(({ product, variant }) => {
                const optionLabel =
                  [variant.color, variant.size, variant.option3].filter(Boolean).join(" / ") || "기본";
                const consumerName = product.consumer_name?.trim();
                const consumerOption = [variant.consumer_color, variant.consumer_size, variant.consumer_option3]
                  .filter(Boolean).join(" / ");
                const qty = value.get(variant.variant_id) ?? 0;
                return (
                  <tr key={variant.variant_id} className={styles.tr}>
                    <td className={styles.tdText}>
                      {consumerName
                        ? <span className="font-medium text-black">{consumerName}</span>
                        : <span className="text-gray-300">미입력</span>}
                    </td>
                    <td className={styles.tdCenter}>
                      {consumerOption
                        ? consumerOption
                        : <span className="text-gray-300">미입력</span>}
                    </td>
                    <td className={styles.tdText}>
                      <div className="text-black">{product.product_name}</div>
                      {product.product_code && (
                        <div className="text-[11px] text-gray-400">{product.product_code}</div>
                      )}
                    </td>
                    <td className={styles.tdCenter}>{optionLabel}</td>
                    <td className={styles.tdRight}>
                      {variant.unit_price > 0
                        ? <span className="text-gray-700">{variant.unit_price.toLocaleString()}</span>
                        : <span className="text-gray-300">-</span>}
                    </td>
                    <td className={styles.tdRight}>
                      <input
                        type="number"
                        inputMode="numeric"
                        min={0}
                        value={qty || ""}
                        onChange={(e) => setQty(variant.variant_id, Number(e.target.value))}
                        className="w-20 px-2 py-1 border border-gray-300 rounded text-right text-black focus:outline-none focus:ring-2 focus:ring-black"
                      />
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function valueToItems(value: Map<string, number>): SubmitItem[] {
  const items: SubmitItem[] = [];
  for (const [variantId, qty] of value) {
    if (qty > 0) items.push({ variant_id: variantId, quantity: qty });
  }
  return items;
}
