"use client";

import { useEffect, useState, useCallback } from "react";
import Link from "next/link";
import { supabase } from "@/lib/supabase";
import { styles } from "@/common/styles";
import { useTenant } from "@/lib/TenantContext";

// TEST 전용 SKU(variant) 목록.
// dev 서버에서만 NavBar 에 노출 (NODE_ENV 체크).
// 현재 tenant 의 활성 variant 전수 표시 — 추후 재고 관리 페이지 기반.
//
// ⚠️ 사장 명시 지시: 리팩토링/정리 작업 중이라도 이 페이지는 삭제하지 말 것.
//    "죽은 코드"로 보여도 삭제 대상 아님 — 별도 안내 있을 때까지 유지.

type Row = {
  id: string;
  color: string | null;
  size: string | null;
  option3: string | null;
  sort_order: number | null;       // 마이그 033 — 등록순 (정렬 안정화 기준)
  barcode: string | null;          // variant 바코드 (마이그 198, 22자리)
  is_active: boolean;
  sold_out: boolean;
  products: {
    id: string;
    consumer_name: string | null;
    wholesale_name: string | null;
    sale_price: number | null;
    barcode: string | null;        // product 바코드 (18자리)
    status: string | null;
    updated_at: string | null;     // 진행/회귀 시 갱신 — 정렬 기준
  } | null;
};

export default function SkuTestPage() {
  const { tenant, loading: tenantLoading } = useTenant();
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [lastFetchedAt, setLastFetchedAt] = useState<number | null>(null);

  const fetchAll = useCallback(async (tenantId: string) => {
    setLoading(true);
    const { data } = await supabase
      .from("product_variants")
      .select(`
        id, color, size, option3, sort_order, barcode, is_active, sold_out,
        products!inner(id, consumer_name, wholesale_name, sale_price, barcode, status, tenant_id, updated_at)
      `)
      .eq("products.tenant_id", tenantId)
      .eq("is_active", true);
    // 정렬은 클라이언트에서 처리.
    // (product_variants 가 부모, products 는 to-one embed 라 .order(foreignTable:"products") 가
    //  부모 행 순서에 효과 없음 → 서버 정렬 제거하고 여기서 박제값 기준 정렬)
    const sorted = ((data ?? []) as unknown as Row[]).sort((a, b) => {
      // 1순위: 최근 진행/변경된 product 가 위로 (진행 시 product.updated_at 갱신)
      const at = a.products?.updated_at ?? "";
      const bt = b.products?.updated_at ?? "";
      if (at !== bt) return at < bt ? 1 : -1;
      // 2순위: 같은 product 안 — 등록순(sort_order) → 바코드 → id 로 완전 결정적.
      //   기존엔 return 0 이라 tiebreak 없어 DB 리턴 순서대로 스크램블됐음 (SML 순서 버그 원인).
      const aso = a.sort_order ?? 0, bso = b.sort_order ?? 0;
      if (aso !== bso) return bso - aso;           // 최신(나중 등록 = 높은 sort_order) 위
      const ac = a.barcode ?? "", bc = b.barcode ?? "";
      if (ac !== bc) return ac < bc ? 1 : -1;      // 바코드 나중 것 위
      return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
    });
    setRows(sorted);
    setLastFetchedAt(Date.now());
    setLoading(false);
  }, []);

  useEffect(() => {
    if (tenant) fetchAll(tenant.id);
  }, [tenant, fetchAll]);

  if (tenantLoading) return <main className={styles.main}>tenant 불러오는 중…</main>;
  if (!tenant) return <main className={styles.main}>로그인 필요</main>;

  const total = rows.length;
  const withBarcode = rows.filter(r => r.barcode).length;
  const registeredProducts = new Set(rows.filter(r => r.products?.status === "registered").map(r => r.products?.id)).size;

  return (
    <main className={styles.main}>
      <div className="mb-4">
        <div className="flex items-center justify-between mb-1">
          <h1 className="text-xl font-bold text-black">
            SKU 목록 <span className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded px-2 py-0.5 ml-2">TEST · COMMIT 안 함 · 재고 관리 예정</span>
          </h1>
          <div className="flex items-center gap-2">
            <button onClick={() => tenant && fetchAll(tenant.id)} disabled={loading}
              className={styles.btnSmall + " disabled:opacity-40"}>
              {loading ? "갱신 중..." : "🔄 새로고침"}
            </button>
            <Link href="/products" className="text-xs text-gray-500 hover:text-black underline">← 내 상품으로</Link>
          </div>
        </div>
        <p className="text-xs text-gray-500">
          tenant: <span className="font-mono">{tenant.company_name}</span>
          {" · "}전체 SKU: <b className="text-black">{total}</b>
          {" · "}바코드 발급됨: <b className="text-black">{withBarcode}</b>
          {" · "}진행 상품 수: <b className="text-black">{registeredProducts}</b>
          {lastFetchedAt && (
            <>{" · "}마지막 갱신: <span className="text-gray-400">{new Date(lastFetchedAt).toLocaleTimeString("ko-KR")}</span></>
          )}
        </p>
      </div>

      {loading ? (
        <p className="text-xs text-gray-400">불러오는 중…</p>
      ) : rows.length === 0 ? (
        <p className="text-xs text-gray-400">SKU 가 없습니다.</p>
      ) : (
        <div className="overflow-auto bg-white border border-gray-200 rounded">
          <table className="w-full text-xs">
            <thead className="bg-gray-50 border-b border-gray-200 sticky top-0">
              <tr className="text-left">
                <th className="px-3 py-2 text-gray-600 font-medium w-12 text-center">#</th>
                <th className="px-3 py-2 text-gray-600 font-medium min-w-[180px]">상품명</th>
                <th className="px-3 py-2 text-gray-600 font-medium w-24">상품상태</th>
                <th className="px-3 py-2 text-gray-600 font-medium w-32">상품 바코드</th>
                <th className="px-3 py-2 text-gray-600 font-medium w-20">컬러</th>
                <th className="px-3 py-2 text-gray-600 font-medium w-20">사이즈</th>
                <th className="px-3 py-2 text-gray-600 font-medium w-20">옵션3</th>
                <th className="px-3 py-2 text-gray-600 font-medium w-40">variant 바코드</th>
                <th className="px-3 py-2 text-gray-600 font-medium w-24 text-right">판매가</th>
                <th className="px-3 py-2 text-gray-600 font-medium w-20 text-center">재고 (예정)</th>
              </tr>
            </thead>
            <tbody className="text-black">
              {rows.map((r, i) => {
                const p = r.products;
                const name = p?.consumer_name || p?.wholesale_name || "(이름 없음)";
                const isRegistered = p?.status === "registered";
                return (
                  <tr key={r.id} className="border-b border-gray-100 hover:bg-gray-50">
                    <td className="px-3 py-2 text-center text-gray-400">{i + 1}</td>
                    <td className="px-3 py-2 truncate max-w-[280px]" title={name}>{name}</td>
                    <td className="px-3 py-2">
                      <span className={`text-[10px] px-1.5 py-0.5 rounded ${
                        isRegistered ? "bg-green-50 text-green-700 border border-green-200"
                                     : "bg-gray-100 text-gray-500"
                      }`}>
                        {isRegistered ? "진행" : (p?.status ?? "-")}
                      </span>
                    </td>
                    <td className="px-3 py-2 font-mono text-[10px] text-gray-600">{p?.barcode ?? <span className="text-gray-300">-</span>}</td>
                    <td className="px-3 py-2">{r.color ?? <span className="text-gray-300">-</span>}</td>
                    <td className="px-3 py-2">{r.size ?? <span className="text-gray-300">-</span>}</td>
                    <td className="px-3 py-2">{r.option3 ?? <span className="text-gray-300">-</span>}</td>
                    <td className="px-3 py-2 font-mono text-[10px] text-gray-600">{r.barcode ?? <span className="text-gray-300">-</span>}</td>
                    <td className="px-3 py-2 text-right">{p?.sale_price?.toLocaleString() ?? "-"}</td>
                    <td className="px-3 py-2 text-center text-gray-300">—</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </main>
  );
}
