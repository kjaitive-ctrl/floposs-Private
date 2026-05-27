"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { styles } from "@/common/styles";
import OrderHeader from "@/components/order/OrderHeader";
import ProductGrid, { valueToItems } from "@/components/order/ProductGrid";
import type { PortalProduct } from "@/lib/orderPortal";

interface TenantBrief {
  id: string;
  company_name: string;
}

export default function BrowseTenantPage() {
  const params = useParams<{ tenantId: string }>();
  const router = useRouter();
  const tenantId = params.tenantId;

  const [tenant, setTenant] = useState<TenantBrief | null>(null);
  const [products, setProducts] = useState<PortalProduct[]>([]);
  const [qty, setQty] = useState<Map<string, number>>(new Map());
  const [loadError, setLoadError] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitting, startSubmit] = useTransition();
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      const res = await fetch(`/api/order-portal/tenants/${tenantId}/products`, { cache: "no-store" });
      const json = (await res.json().catch(() => ({}))) as {
        tenant?: TenantBrief;
        products?: PortalProduct[];
        error?: string;
      };
      if (cancelled) return;
      if (!res.ok) {
        setLoadError(json.error ?? "상품 정보를 불러오지 못했습니다.");
      } else {
        setTenant(json.tenant ?? null);
        setProducts(json.products ?? []);
      }
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [tenantId]);

  const totalQty = useMemo(() => Array.from(qty.values()).reduce((a, b) => a + b, 0), [qty]);

  async function handleSubmit() {
    setSubmitError(null);
    const items = valueToItems(qty);
    if (items.length === 0) {
      setSubmitError("주문할 상품/수량을 1건 이상 입력해주세요.");
      return;
    }

    const res = await fetch("/api/order-portal/submit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ wholesale_tenant_id: tenantId, items }),
    });
    const json = (await res.json().catch(() => ({}))) as {
      success?: boolean;
      order_number?: string;
      error?: string;
    };

    if (!res.ok || !json.success) {
      setSubmitError(json.error ?? "주문 전송에 실패했습니다.");
      return;
    }

    startSubmit(() => {
      const url = new URL("/order/complete", window.location.origin);
      if (json.order_number) url.searchParams.set("no", json.order_number);
      if (tenant?.company_name) url.searchParams.set("ws", tenant.company_name);
      router.push(url.pathname + "?" + url.searchParams.toString());
    });
  }

  return (
    <>
      <OrderHeader />
      <main className={styles.main}>
        <div className="flex items-center gap-3 mb-4">
          <Link href="/order/browse" className="text-xs text-gray-500 hover:text-black">
            ← 도매 매장 목록
          </Link>
        </div>

        <h1 className="text-xl font-bold text-black mb-1">{tenant?.company_name ?? "…"}</h1>
        <p className="text-xs text-gray-500 mb-4">
          필요한 수량만 입력해서 한 번에 보내세요. 단가/금액은 도매에서 확정합니다.
        </p>

        {loadError && (
          <div className="text-xs text-red-600 bg-red-50 border border-red-200 rounded px-3 py-2 mb-3">
            {loadError}
          </div>
        )}

        {loading ? (
          <div className="text-xs text-gray-400">상품 불러오는 중…</div>
        ) : (
          <ProductGrid products={products} value={qty} onChange={setQty} />
        )}

        {submitError && (
          <div className="text-xs text-red-600 bg-red-50 border border-red-200 rounded px-3 py-2 mt-3">
            {submitError}
          </div>
        )}

        <div className="sticky bottom-0 mt-4 bg-white border border-gray-200 rounded-xl px-4 py-3 flex items-center gap-3">
          <div className="text-xs text-gray-500">
            선택 합계 <span className="text-black font-semibold">{totalQty}</span> 개
          </div>
          <button
            type="button"
            onClick={handleSubmit}
            disabled={submitting || totalQty === 0}
            className={`${styles.btnPrimary} ml-auto disabled:opacity-50`}
          >
            {submitting ? "전송 중…" : "주문 전송"}
          </button>
        </div>
      </main>
    </>
  );
}
