"use client";

// 상품현황 — 거래처별 상품 진열/품절/시즌 관리 대시보드. 마이그 216.
// [[project_retail_work_routines]] 옆에 나란히 두는 신규 관리 탭 (2026-07-21 설계).
// 거래처(retail_suppliers) 중 상품이 1개 이상 연결된 것만 그룹으로 노출.
// 각 상품 행에서 바로 품절/진열/시즌오프 처리 — /products 는 상세편집 갈 때만 링크.

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { supabase } from "@/lib/supabase";
import { PRODUCT_STATUSES } from "@/common/constants";
import { styles } from "@/common/styles";
import { useTenant } from "@/lib/TenantContext";
import { loadMySuppliers, type MySupplier } from "@/lib/retailSuppliers";

interface StatusRow {
  id: string;
  consumer_name: string | null;
  wholesale_name: string | null;
  retail_supplier_id: string | null;
  registered_at: string | null;
  launch_date: string | null;
  sold_out: boolean;
  season: string | null;
  season_status: "active" | "season_off";
  cafe24_product_no: number | null;
  cafe24_display: boolean;
}

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  return iso.slice(0, 10);
}

export default function ProductStatusPage() {
  const { tenant, loading: tenantLoading, error: tenantError } = useTenant();
  const [loading, setLoading] = useState(true);
  const [suppliers, setSuppliers] = useState<MySupplier[]>([]);
  const [rows, setRows] = useState<StatusRow[]>([]);
  const [cafe24Connected, setCafe24Connected] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [seasonDraft, setSeasonDraft] = useState<Record<string, string>>({});
  const [busyId, setBusyId] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  // 진단용 — 전체 등록상품 중 거래처 미연결 개수 (거래처가 안 뜰 때 원인 구분용)
  const [unlinkedCount, setUnlinkedCount] = useState<number | null>(null);

  useEffect(() => {
    if (!tenant?.id) return;
    let cancelled = false;
    (async () => {
      setLoading(true);
      setLoadError(null);
      const [supplierList, productRes, tenantRes, totalRes] = await Promise.all([
        loadMySuppliers(tenant.id),
        supabase.from("products")
          .select("id, consumer_name, wholesale_name, retail_supplier_id, registered_at, launch_date, sold_out, season, season_status, cafe24_product_no, cafe24_display")
          .eq("tenant_id", tenant.id)
          .eq("is_active", true)
          .in("status", PRODUCT_STATUSES)
          .not("retail_supplier_id", "is", null)
          .order("registered_at", { ascending: false, nullsFirst: false }),
        supabase.from("tenants").select("cafe24_mall_id").eq("id", tenant.id).single(),
        supabase.from("products").select("id", { count: "exact", head: true })
          .eq("tenant_id", tenant.id).eq("is_active", true).in("status", PRODUCT_STATUSES),
      ]);
      if (cancelled) return;
      if (productRes.error) {
        console.error("product-status products fetch:", productRes.error);
        setLoadError(productRes.error.message);
      }
      setSuppliers(supplierList);
      setRows((productRes.data ?? []) as StatusRow[]);
      setUnlinkedCount((totalRes.count ?? 0) - (productRes.data?.length ?? 0));
      setCafe24Connected(!!(tenantRes.data as { cafe24_mall_id?: string | null } | null)?.cafe24_mall_id);
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [tenant?.id]);

  const grouped = useMemo(() => {
    const map = new Map<string, StatusRow[]>();
    for (const r of rows) {
      if (!r.retail_supplier_id) continue;
      const list = map.get(r.retail_supplier_id) ?? [];
      list.push(r);
      map.set(r.retail_supplier_id, list);
    }
    return map;
  }, [rows]);

  const suppliersWithProducts = useMemo(
    () => suppliers.filter(s => (grouped.get(s.id)?.length ?? 0) > 0),
    [suppliers, grouped],
  );

  function toggleExpand(id: string) {
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  async function toggleSoldOut(row: StatusRow) {
    const next = !row.sold_out;
    setRows(prev => prev.map(r => r.id === row.id ? { ...r, sold_out: next } : r));
    const { error } = await supabase.from("products")
      .update({ sold_out: next, updated_at: new Date().toISOString() })
      .eq("id", row.id);
    if (error) {
      alert(`품절 토글 실패: ${error.message}`);
      setRows(prev => prev.map(r => r.id === row.id ? { ...r, sold_out: row.sold_out } : r));
    }
  }

  // 카페24 연동 상품이면 display PUT 까지 같이 — 실패해도 season_status 는 유지 (best-effort 동기화).
  async function pushDisplay(productId: string, display: "T" | "F"): Promise<boolean> {
    try {
      const res = await fetch("/api/cafe24/display", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ productId, display }),
      });
      const data = await res.json() as { ok?: boolean; error?: string };
      if (!res.ok || !data.ok) { alert(`카페24 진열 반영 실패: ${data.error ?? "알 수 없는 오류"}`); return false; }
      return true;
    } catch (e) {
      alert(`카페24 진열 반영 실패: ${String(e)}`);
      return false;
    }
  }

  function canTouchCafe24(row: StatusRow): boolean {
    return cafe24Connected && row.cafe24_product_no != null;
  }

  async function toggleDisplay(row: StatusRow) {
    if (!canTouchCafe24(row)) return;
    setBusyId(row.id);
    const next = !row.cafe24_display;
    const ok = await pushDisplay(row.id, next ? "T" : "F");
    if (ok) setRows(prev => prev.map(r => r.id === row.id ? { ...r, cafe24_display: next } : r));
    setBusyId(null);
  }

  // 시즌오프 ⇄ 재진행 — 같은 row 그대로 season_status 만 갱신 (사장 결정, 이력 별도 저장 안 함).
  async function toggleSeasonStatus(row: StatusRow) {
    setBusyId(row.id);
    const next: "active" | "season_off" = row.season_status === "active" ? "season_off" : "active";
    const { error } = await supabase.from("products")
      .update({ season_status: next, updated_at: new Date().toISOString() })
      .eq("id", row.id);
    if (error) {
      alert(`시즌 상태 변경 실패: ${error.message}`);
      setBusyId(null);
      return;
    }
    setRows(prev => prev.map(r => r.id === row.id ? { ...r, season_status: next } : r));

    // 연동 상품이면 진열도 같이 반영 — 시즌오프=진열내림, 재진행=진열복구
    if (canTouchCafe24(row)) {
      const displayNext = next === "active";
      const ok = await pushDisplay(row.id, displayNext ? "T" : "F");
      if (ok) setRows(prev => prev.map(r => r.id === row.id ? { ...r, cafe24_display: displayNext } : r));
    }
    setBusyId(null);
  }

  async function saveSeason(row: StatusRow) {
    const draft = seasonDraft[row.id];
    if (draft === undefined || draft === (row.season ?? "")) return;
    const value = draft.trim() || null;
    const { error } = await supabase.from("products").update({ season: value }).eq("id", row.id);
    if (error) { alert(`시즌 태그 저장 실패: ${error.message}`); return; }
    setRows(prev => prev.map(r => r.id === row.id ? { ...r, season: value } : r));
  }

  function productLink(row: StatusRow, supplierId: string, supplierName: string): string {
    const name = row.consumer_name || row.wholesale_name || "";
    const p = new URLSearchParams({ supplier: supplierId, supplierName });
    if (name) p.set("q", name);
    return `/products?${p.toString()}`;
  }

  if (tenantLoading) return <main className={styles.main}><p className="text-xs text-gray-400">불러오는 중…</p></main>;
  if (tenantError || !tenant) return <main className={styles.main}><p className={styles.msgError}>{tenantError || "테넌트 정보 없음"}</p></main>;

  return (
    <main className={styles.main}>
      <div className="flex items-center justify-between mb-4">
        <h1 className={styles.headerTitle}>상품현황</h1>
        <span className="text-xs text-gray-400">
          거래처 {suppliersWithProducts.length}곳 · 상품 {rows.length}개
        </span>
      </div>

      {!cafe24Connected && (
        <div className={`${styles.msgWarn} mb-4`}>
          카페24 미연동 — 진열/시즌오프 버튼은 내부 상태만 바뀝니다. (설정에서 카페24 연동 시 진열도 함께 반영)
        </div>
      )}

      {loadError && (
        <div className={`${styles.msgError} mb-4`}>상품 목록 로드 실패: {loadError}</div>
      )}

      {loading ? (
        <p className="text-xs text-gray-400">불러오는 중…</p>
      ) : suppliersWithProducts.length === 0 ? (
        <div className="text-xs text-gray-400 space-y-1">
          <p>상품이 연결된 거래처가 없습니다.</p>
          <p>
            (진단: 등록된 거래처 {suppliers.length}곳 · 거래처 연결 없는 등록상품 {unlinkedCount ?? "—"}개.
            상품 등록 시 공급사를 자유텍스트로만 입력하고 자동완성에서 실제 거래처를 선택하지 않으면
            거래처가 연결되지 않아 여기 안 뜹니다 — /products 에서 공급사 칸을 자동완성으로 다시 선택해보세요.)
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {suppliersWithProducts.map(s => {
            const list = grouped.get(s.id) ?? [];
            const isOpen = expanded.has(s.id);
            return (
              <div key={s.id} className={styles.card + " p-0 overflow-hidden"}>
                <button type="button" onClick={() => toggleExpand(s.id)}
                  className="w-full flex items-center justify-between px-4 py-3 hover:bg-gray-50 text-left">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-semibold text-black">{s.store_name}</span>
                    <span className="text-xs text-gray-400">{s.loc}</span>
                  </div>
                  <div className="flex items-center gap-3">
                    <span className="text-xs text-gray-500">상품 {list.length}개</span>
                    <span className="text-gray-300 text-xs">{isOpen ? "▲" : "▼"}</span>
                  </div>
                </button>

                {isOpen && (
                  <table className="w-full text-xs border-t border-gray-100">
                    <thead>
                      <tr className="bg-gray-50">
                        <th className={styles.thLeft}>상품명</th>
                        <th className={styles.thLeft}>도매상품명</th>
                        <th className={styles.th}>등록일</th>
                        <th className={styles.th}>품절</th>
                        <th className={styles.th}>진열</th>
                        <th className={styles.th}>시즌</th>
                        <th className={styles.th}>시즌상태</th>
                      </tr>
                    </thead>
                    <tbody>
                      {list.map(row => {
                        const cafe24Ok = canTouchCafe24(row);
                        const busy = busyId === row.id;
                        return (
                          <tr key={row.id} className={styles.tr}>
                            <td className={styles.tdText}>
                              <Link href={productLink(row, s.id, s.store_name)}
                                className="text-primary hover:underline">
                                {row.consumer_name || row.wholesale_name || "(이름 없음)"}
                              </Link>
                            </td>
                            <td className={styles.tdText}>{row.wholesale_name || "—"}</td>
                            <td className={styles.tdCenter}>{fmtDate(row.registered_at || row.launch_date)}</td>
                            <td className={styles.tdCenter}>
                              <button type="button" onClick={() => toggleSoldOut(row)}
                                className={"px-2 py-0.5 rounded border text-[11px] " +
                                  (row.sold_out ? "border-red-300 text-red-600 bg-red-50" : "border-gray-200 text-gray-500 hover:bg-gray-50")}>
                                {row.sold_out ? "품절" : "정상"}
                              </button>
                            </td>
                            <td className={styles.tdCenter}>
                              <button type="button" onClick={() => toggleDisplay(row)}
                                disabled={!cafe24Ok || busy}
                                title={!cafe24Ok ? "카페24 미등록 상품" : undefined}
                                className={"px-2 py-0.5 rounded border text-[11px] disabled:opacity-40 disabled:cursor-not-allowed " +
                                  (row.cafe24_display ? "border-emerald-300 text-emerald-700 bg-emerald-50" : "border-gray-200 text-gray-500 hover:bg-gray-50")}>
                                {row.cafe24_display ? "진열중" : "미진열"}
                              </button>
                            </td>
                            <td className={styles.tdCenter}>
                              <input
                                defaultValue={row.season ?? ""}
                                placeholder="예: 2026SS"
                                onChange={e => setSeasonDraft(prev => ({ ...prev, [row.id]: e.target.value }))}
                                onBlur={() => saveSeason(row)}
                                className="w-20 px-1.5 py-0.5 border border-gray-200 rounded text-[11px] text-center text-black focus:outline-none focus:ring-1 focus:ring-primary-ring"
                              />
                            </td>
                            <td className={styles.tdCenter}>
                              <button type="button" onClick={() => toggleSeasonStatus(row)}
                                disabled={busy}
                                className={"px-2 py-0.5 rounded border text-[11px] disabled:opacity-40 " +
                                  (row.season_status === "season_off"
                                    ? "border-amber-300 text-amber-700 bg-amber-50"
                                    : "border-gray-200 text-gray-500 hover:bg-gray-50")}>
                                {row.season_status === "season_off" ? "재진행" : "시즌오프"}
                              </button>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                )}
              </div>
            );
          })}
        </div>
      )}
    </main>
  );
}
