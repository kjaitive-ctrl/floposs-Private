"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { styles } from "@/common/styles";
import OrderHeader from "@/components/order/OrderHeader";
import type { WholesaleTenantBrief } from "@/lib/orderPortal";

export default function BrowsePage() {
  const [q, setQ] = useState("");
  const [tenants, setTenants] = useState<WholesaleTenantBrief[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(async () => {
      setLoading(true);
      setError(null);
      try {
        const url = new URL("/api/order-portal/tenants/search", window.location.origin);
        if (q.trim()) url.searchParams.set("q", q.trim());
        const res = await fetch(url.toString(), { cache: "no-store" });
        const json = (await res.json().catch(() => ({}))) as {
          tenants?: WholesaleTenantBrief[];
          error?: string;
        };
        if (cancelled) return;
        if (!res.ok) {
          setError(json.error ?? "검색에 실패했습니다.");
          setTenants([]);
        } else {
          setTenants(json.tenants ?? []);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }, 250);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [q]);

  return (
    <>
      <OrderHeader />
      <main className={styles.main}>
        <h1 className="text-xl font-bold text-black mb-1">도매 매장 찾기</h1>
        <p className="text-xs text-gray-500 mb-4">매장명, 사장님 이름, 연락처, 주소로 검색해보세요.</p>

        <div className="mb-4">
          <input
            className={`${styles.filterInput} w-full`}
            type="search"
            placeholder="검색어를 입력하세요"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            autoFocus
          />
        </div>

        {error && (
          <div className="text-xs text-red-600 bg-red-50 border border-red-200 rounded px-3 py-2 mb-3">
            {error}
          </div>
        )}

        {loading ? (
          <div className="text-xs text-gray-400">검색 중…</div>
        ) : tenants.length === 0 ? (
          <div className="text-xs text-gray-400">결과가 없습니다.</div>
        ) : (
          <ul className="space-y-2">
            {tenants.map((t) => (
              <li key={t.id}>
                <Link
                  href={`/order/browse/${t.id}`}
                  className="block bg-white border border-gray-200 rounded-xl px-4 py-3 hover:border-black transition-colors"
                >
                  <div className="font-medium text-black">{t.company_name}</div>
                  <div className="text-xs text-gray-500 mt-0.5">
                    {[t.owner_name, t.phone, t.address].filter(Boolean).join(" · ") || "—"}
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </main>
    </>
  );
}
