"use client";

import { useEffect, useMemo, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { styles } from "@/common/styles";
import { useTenant } from "@/lib/TenantContext";
import ProductGrid from "@/components/order/ProductGrid";
import { loadSupplierBrief, loadSupplierProducts, type MySupplier } from "@/lib/retailSuppliers";
import type { PortalProduct } from "@/lib/orderPortal";

// 거래처별 "내 상품" 발주 (안건3 C3). param = retail_supplier_id.
// 옛: wholesale tenant 의 상품을 API(cross-tenant)로 load. 새: retail_supplier_id 태깅된 내 상품 browser-direct.
// submit 은 C4 (orders 전자노트) — 지금은 stub. [[project_retail_slot_order_portal_v2]]
export default function SupplierOrderPage() {
  const params = useParams<{ supplierId: string }>();
  const supplierId = params.supplierId;
  const { tenant } = useTenant();

  const [supplier, setSupplier] = useState<MySupplier | null>(null);
  const [products, setProducts] = useState<PortalProduct[]>([]);
  const [qty, setQty] = useState<Map<string, number>>(new Map());
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!tenant?.id || !supplierId) return;
    let cancelled = false;
    (async () => {
      setLoading(true);
      const [brief, prods] = await Promise.all([
        loadSupplierBrief(tenant.id, supplierId),
        loadSupplierProducts(tenant.id, supplierId),
      ]);
      if (cancelled) return;
      setSupplier(brief);
      setProducts(prods);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [tenant?.id, supplierId]);

  const totalQty = useMemo(() => Array.from(qty.values()).reduce((a, b) => a + b, 0), [qty]);

  function handleSubmit() {
    // C4 에서 orders(전자노트) 박제로 연결 예정. 지금은 stub.
    alert("주문 전송은 다음 단계(C4)에서 orders 전자노트로 연결됩니다.");
  }

  return (
    <>
      <main className={styles.main}>
        <div className="flex items-center gap-3 mb-4">
          <Link href="/order/browse" className="text-xs text-gray-500 hover:text-black">
            ← 거래처 목록
          </Link>
        </div>

        <h1 className="text-xl font-bold text-black mb-1">
          {supplier?.store_name ?? "…"}
          {supplier?.loc && <span className="text-gray-400 font-normal text-base"> · {supplier.loc}</span>}
        </h1>
        <p className="text-xs text-gray-500 mb-4">
          이 거래처로 등록한 내 상품입니다. 필요한 수량만 입력해서 한 번에 보내세요.
        </p>

        {loading ? (
          <div className="text-xs text-gray-400">상품 불러오는 중…</div>
        ) : products.length === 0 ? (
          <div className="text-sm text-gray-500 bg-gray-50 border border-gray-200 rounded-xl px-4 py-6 text-center leading-relaxed">
            이 거래처로 등록된 상품이 없습니다.
            <br />
            <Link href="/samples" className="text-primary hover:underline font-medium">
              샘플 등록
            </Link>
            에서 이 거래처의 상품을 먼저 추가하세요.
          </div>
        ) : (
          <ProductGrid products={products} value={qty} onChange={setQty} />
        )}

        {products.length > 0 && (
          <div className="sticky bottom-0 mt-4 bg-white border border-gray-200 rounded-xl px-4 py-3 flex items-center gap-3">
            <div className="text-xs text-gray-500">
              선택 합계 <span className="text-black font-semibold">{totalQty}</span> 개
            </div>
            <button
              type="button"
              onClick={handleSubmit}
              disabled={totalQty === 0}
              className={`${styles.btnPrimary} ml-auto disabled:opacity-50`}
            >
              주문 전송 (C4 예정)
            </button>
          </div>
        )}
      </main>
    </>
  );
}
