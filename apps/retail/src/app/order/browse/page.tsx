"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { styles } from "@/common/styles";
import { useTenant } from "@/lib/TenantContext";
import SupplierAutocomplete from "@/components/SupplierAutocomplete";
import SupplierAddressSearch from "@/components/SupplierAddressSearch";
import { loadMySuppliers, type MySupplier } from "@/lib/retailSuppliers";

// 주문포털 거래처 선택 (안건3 C2). 내 거래처(retail_suppliers) 검색·선택 + 전체 매장 검색해 실시간 등록.
// 옛 wholesale-tenant cross-tenant 검색(API+supabaseAdmin) → 내 DB 브라우저 직통으로 교체.
// 전체 매장 검색/등록 = 샘플과 같은 SupplierAutocomplete + SupplierRegisterModal 재사용.
// [[feedback_retail_browser_supabase_direct]] [[project_retail_slot_order_portal_v2]]
export default function BrowsePage() {
  const { tenant } = useTenant();
  const [q, setQ] = useState("");
  const [suppliers, setSuppliers] = useState<MySupplier[]>([]);
  const [loading, setLoading] = useState(true);
  const [addText, setAddText] = useState("");
  const [addMode, setAddMode] = useState<"name" | "addr">("name");

  const reload = useCallback(async () => {
    if (!tenant?.id) return;
    setSuppliers(await loadMySuppliers(tenant.id));
  }, [tenant?.id]);

  useEffect(() => {
    if (!tenant?.id) return;
    let cancelled = false;
    (async () => {
      setLoading(true);
      const rows = await loadMySuppliers(tenant.id);
      if (cancelled) return;
      setSuppliers(rows);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [tenant?.id]);

  // 전체 매장 검색 → 선택/신규등록 시 supplierId 박제됨 → 내 거래처 목록 실시간 갱신.
  // 타이핑 중(supplierId null)엔 입력값만 반영.
  function handleAdd(text: string, supplierId: string | null) {
    if (supplierId) {
      setAddText("");
      reload();
    } else {
      setAddText(text);
    }
  }

  const filtered = useMemo(() => {
    const term = q.trim().toLowerCase();
    if (!term) return suppliers;
    return suppliers.filter(
      (s) =>
        s.store_name.toLowerCase().includes(term) ||
        s.loc.toLowerCase().includes(term) ||
        (s.phone ?? "").includes(term) ||
        (s.smartphone ?? "").includes(term)
    );
  }, [q, suppliers]);

  return (
    <>
      <main className={styles.main}>
        <div className="flex items-center justify-between mb-1">
          <h1 className="text-xl font-bold text-black">거래처 선택</h1>
          <Link href="/order/notes" className="text-xs text-gray-600 hover:text-black border border-gray-200 rounded px-2 py-1">
            📋 내 주문내역
          </Link>
        </div>
        <p className="text-xs text-gray-500 mb-4">주문할 거래처(도매 매장)를 검색해서 선택하세요.</p>

        {/* 거래처 추가 — 전체 매장(slot DB)에서 검색해 내 거래처로 실시간 등록 */}
        {tenant?.id && (
          <div className="mb-5 bg-emerald-50 border border-emerald-200 rounded-xl px-4 py-3">
            <div className="flex items-center justify-between mb-2">
              <div className="text-xs font-semibold text-emerald-800">
                + 거래처 추가
                <span className="ml-1 font-normal text-emerald-700">전체 매장에서 검색해 내 거래처로 등록</span>
              </div>
              <div className="flex rounded-lg overflow-hidden border border-emerald-300 text-xs">
                {(["name", "addr"] as const).map((m) => (
                  <button
                    key={m}
                    type="button"
                    onClick={() => setAddMode(m)}
                    className={`px-2.5 py-1 font-medium ${
                      addMode === m ? "bg-emerald-600 text-white" : "bg-white text-emerald-700 hover:bg-emerald-100"
                    }`}
                  >
                    {m === "name" ? "이름 검색" : "주소 검색"}
                  </button>
                ))}
              </div>
            </div>
            {addMode === "name" ? (
              <SupplierAutocomplete
                tenantId={tenant.id}
                value={addText}
                supplierId={null}
                onChange={handleAdd}
                className={`${styles.inputMd} bg-white`}
              />
            ) : (
              <SupplierAddressSearch tenantId={tenant.id} onPicked={reload} />
            )}
          </div>
        )}

        {/* 내 거래처 */}
        <div className="flex items-center justify-between mb-2">
          <h2 className="text-sm font-bold text-black">내 거래처 <span className="text-gray-400 font-normal">({suppliers.length})</span></h2>
        </div>
        <div className="mb-3">
          <input
            className={`${styles.filterInput} w-full`}
            type="search"
            placeholder="내 거래처 내에서 검색 (거래처명 · 위치 · 연락처)"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        </div>

        {loading ? (
          <div className="text-xs text-gray-400">불러오는 중…</div>
        ) : suppliers.length === 0 ? (
          <div className="text-sm text-gray-500 bg-gray-50 border border-gray-200 rounded-xl px-4 py-6 text-center leading-relaxed">
            아직 등록된 거래처가 없습니다.
            <br />
            위 <b>거래처 추가</b>에서 매장을 검색해 등록하거나,{" "}
            <Link href="/samples" className="text-primary hover:underline font-medium">
              샘플 등록
            </Link>
            에서 추가하세요.
          </div>
        ) : filtered.length === 0 ? (
          <div className="text-xs text-gray-400">검색 결과가 없습니다.</div>
        ) : (
          <ul className="space-y-2">
            {filtered.map((s) => (
              <li key={s.id}>
                <Link
                  href={`/order/browse/${s.id}`}
                  className="block bg-white border border-gray-200 rounded-xl px-4 py-3 hover:border-black transition-colors"
                >
                  <div className="font-medium text-black">
                    {s.store_name}
                    {s.loc && <span className="text-gray-400 font-normal"> · {s.loc}</span>}
                  </div>
                  <div className="text-xs text-gray-500 mt-0.5">
                    {[s.smartphone, s.phone].filter(Boolean).join(" · ") || "—"}
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
