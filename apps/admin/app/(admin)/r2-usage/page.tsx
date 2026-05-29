"use client";

import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";

// R2 이미지 용량 — tenant 별 사용량/한도/사용률.
// 마이그 200 의 tenants.r2_usage_bytes 캐시 + subscription_plans.r2_storage_quota_mb 한도 활용.
// 캐시는 product_images 트리거로 자동 갱신.

type Row = {
  id: string;
  company_name: string;
  tenant_type: string;
  status: string;
  r2_usage_bytes: number;
  r2_image_count: number;
  r2_usage_updated_at: string | null;
  plan: { name: string; r_quota_mb: number } | null;
};

type RawRow = {
  id: string;
  company_name: string;
  tenant_type: string;
  status: string;
  r2_usage_bytes: number | null;
  r2_image_count: number | null;
  r2_usage_updated_at: string | null;
  subscription_plans: { name: string; r2_storage_quota_mb: number } | null;
};

function formatBytes(b: number): string {
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  if (b < 1024 * 1024 * 1024) return `${(b / 1024 / 1024).toFixed(1)} MB`;
  return `${(b / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function quotaLabel(mb: number): string {
  if (mb === 0) return "무제한";
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`;
  return `${mb} MB`;
}

type SortKey = "usage_desc" | "usage_asc" | "ratio_desc" | "count_desc" | "name";

export default function R2UsagePage() {
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [filterType, setFilterType] = useState<string>("all");
  const [filterOver, setFilterOver] = useState(false);  // 90%+ 만
  const [sort, setSort] = useState<SortKey>("usage_desc");
  const [search, setSearch] = useState("");

  useEffect(() => { fetchRows(); }, []);

  async function fetchRows() {
    setLoading(true);
    const { data } = await supabase
      .from("tenants")
      .select(`
        id, company_name, tenant_type, status,
        r2_usage_bytes, r2_image_count, r2_usage_updated_at,
        subscription_plans!plan_id(name, r2_storage_quota_mb)
      `)
      .order("r2_usage_bytes", { ascending: false });

    const list: Row[] = ((data ?? []) as unknown as RawRow[]).map(d => ({
      id: d.id,
      company_name: d.company_name,
      tenant_type: d.tenant_type,
      status: d.status,
      r2_usage_bytes: d.r2_usage_bytes ?? 0,
      r2_image_count: d.r2_image_count ?? 0,
      r2_usage_updated_at: d.r2_usage_updated_at,
      plan: d.subscription_plans
        ? { name: d.subscription_plans.name, r_quota_mb: d.subscription_plans.r2_storage_quota_mb ?? 0 }
        : null,
    }));
    setRows(list);
    setLoading(false);
  }

  // 필터 + 정렬
  let view = rows;
  if (filterType !== "all") view = view.filter(r => r.tenant_type === filterType);
  if (search.trim()) view = view.filter(r => r.company_name.toLowerCase().includes(search.toLowerCase()));
  if (filterOver) view = view.filter(r => {
    const q = (r.plan?.r_quota_mb ?? 0) * 1024 * 1024;
    return q > 0 && r.r2_usage_bytes >= q * 0.9;
  });

  view = [...view].sort((a, b) => {
    if (sort === "usage_desc") return b.r2_usage_bytes - a.r2_usage_bytes;
    if (sort === "usage_asc")  return a.r2_usage_bytes - b.r2_usage_bytes;
    if (sort === "count_desc") return b.r2_image_count - a.r2_image_count;
    if (sort === "name")       return a.company_name.localeCompare(b.company_name);
    // ratio_desc
    const ar = ratio(a), br = ratio(b);
    return br - ar;
  });

  function ratio(r: Row): number {
    const q = (r.plan?.r_quota_mb ?? 0) * 1024 * 1024;
    if (q === 0) return -1;  // 무제한은 정렬 아래로
    return r.r2_usage_bytes / q;
  }

  const totalBytes = rows.reduce((sum, r) => sum + r.r2_usage_bytes, 0);
  const totalCount = rows.reduce((sum, r) => sum + r.r2_image_count, 0);
  const overCount = rows.filter(r => {
    const q = (r.plan?.r_quota_mb ?? 0) * 1024 * 1024;
    return q > 0 && r.r2_usage_bytes >= q * 0.9;
  }).length;

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <div>
          <h2 className="text-2xl font-bold text-gray-900">이미지 용량</h2>
          <p className="text-sm text-gray-500 mt-0.5">
            tenant 별 R2 이미지 사용량 · 한도 · 사용률 (마이그 200 캐시 기반, 트리거 자동 갱신)
          </p>
        </div>
        <button onClick={fetchRows}
          className="px-3 py-1.5 border border-gray-300 text-sm rounded-lg hover:bg-gray-50">
          ↻ 새로고침
        </button>
      </div>

      {/* 요약 카드 */}
      <div className="grid grid-cols-4 gap-3 mb-5">
        <SummaryCard label="총 사용량" value={formatBytes(totalBytes)} />
        <SummaryCard label="총 이미지 수" value={`${totalCount.toLocaleString()}장`} />
        <SummaryCard label="등록 tenant" value={`${rows.length}개`} />
        <SummaryCard label="90%+ tenant"
          value={`${overCount}개`}
          accent={overCount > 0 ? "warn" : undefined} />
      </div>

      {/* 필터 */}
      <div className="flex items-center gap-3 mb-3 flex-wrap">
        <input type="text" value={search} onChange={e => setSearch(e.target.value)}
          placeholder="업체명 검색"
          className="px-3 py-1.5 text-sm border border-gray-300 rounded-lg w-48" />
        <select value={filterType} onChange={e => setFilterType(e.target.value)}
          className="px-3 py-1.5 text-sm border border-gray-300 rounded-lg">
          <option value="all">전체 vertical</option>
          <option value="retail">retail</option>
          <option value="wholesale">wholesale</option>
          <option value="logistics">logistics</option>
          <option value="designer">designer</option>
          <option value="platform">platform</option>
          <option value="restaurant">restaurant</option>
          <option value="other">other</option>
        </select>
        <select value={sort} onChange={e => setSort(e.target.value as SortKey)}
          className="px-3 py-1.5 text-sm border border-gray-300 rounded-lg">
          <option value="usage_desc">사용량 ↓</option>
          <option value="usage_asc">사용량 ↑</option>
          <option value="ratio_desc">사용률 ↓</option>
          <option value="count_desc">이미지 수 ↓</option>
          <option value="name">업체명</option>
        </select>
        <label className="flex items-center gap-1 text-sm text-gray-700">
          <input type="checkbox" checked={filterOver}
            onChange={e => setFilterOver(e.target.checked)}
            className="rounded" />
          90%+ 만
        </label>
        <span className="ml-auto text-xs text-gray-500">{view.length} / {rows.length} 표시</span>
      </div>

      {/* 표 */}
      {loading ? (
        <p className="text-sm text-gray-400">불러오는 중...</p>
      ) : view.length === 0 ? (
        <p className="text-sm text-gray-400 text-center py-12 border border-dashed border-gray-200 rounded-lg">
          조건에 맞는 tenant 가 없습니다.
        </p>
      ) : (
        <div className="bg-white border border-gray-200 rounded-lg overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b border-gray-200">
              <tr>
                <th className="text-left px-3 py-2 font-medium text-gray-600">업체명</th>
                <th className="text-left px-3 py-2 font-medium text-gray-600">vertical</th>
                <th className="text-left px-3 py-2 font-medium text-gray-600">플랜</th>
                <th className="text-right px-3 py-2 font-medium text-gray-600">사용량</th>
                <th className="text-right px-3 py-2 font-medium text-gray-600">한도</th>
                <th className="text-left px-3 py-2 font-medium text-gray-600">사용률</th>
                <th className="text-right px-3 py-2 font-medium text-gray-600">이미지 수</th>
                <th className="text-left px-3 py-2 font-medium text-gray-600">갱신</th>
              </tr>
            </thead>
            <tbody>
              {view.map(r => {
                const quotaBytes = (r.plan?.r_quota_mb ?? 0) * 1024 * 1024;
                const unlimited = quotaBytes === 0;
                const pct = unlimited ? 0 : Math.min(100, (r.r2_usage_bytes / quotaBytes) * 100);
                const overWarn = !unlimited && pct >= 90;
                const overFull = !unlimited && pct >= 100;
                return (
                  <tr key={r.id} className="border-b border-gray-100 hover:bg-gray-50">
                    <td className="px-3 py-2 font-medium text-gray-900">{r.company_name}</td>
                    <td className="px-3 py-2 text-gray-600">{r.tenant_type}</td>
                    <td className="px-3 py-2 text-gray-600">
                      {r.plan?.name ?? <span className="text-gray-400">— 미지정</span>}
                    </td>
                    <td className="px-3 py-2 text-right text-gray-900">{formatBytes(r.r2_usage_bytes)}</td>
                    <td className="px-3 py-2 text-right text-gray-600">
                      {r.plan ? quotaLabel(r.plan.r_quota_mb) : "—"}
                    </td>
                    <td className="px-3 py-2">
                      {unlimited ? (
                        <span className="text-xs text-gray-400">무제한</span>
                      ) : (
                        <div className="flex items-center gap-2">
                          <div className="flex-1 h-2 bg-gray-200 rounded overflow-hidden max-w-[120px]">
                            <div className={`h-full ${overFull ? "bg-red-500" : overWarn ? "bg-orange-500" : "bg-blue-500"}`}
                              style={{ width: `${pct}%` }} />
                          </div>
                          <span className={`text-xs font-medium ${overFull ? "text-red-600" : overWarn ? "text-orange-600" : "text-gray-700"}`}>
                            {pct.toFixed(0)}%
                          </span>
                        </div>
                      )}
                    </td>
                    <td className="px-3 py-2 text-right text-gray-600">{r.r2_image_count.toLocaleString()}</td>
                    <td className="px-3 py-2 text-[11px] text-gray-400">
                      {r.r2_usage_updated_at
                        ? new Date(r.r2_usage_updated_at).toLocaleString("ko-KR", { dateStyle: "short", timeStyle: "short" })
                        : "—"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function SummaryCard({ label, value, accent }: { label: string; value: string; accent?: "warn" }) {
  return (
    <div className={`bg-white border rounded-lg p-3 ${
      accent === "warn" ? "border-orange-300 bg-orange-50/50" : "border-gray-200"
    }`}>
      <div className="text-xs text-gray-500 mb-0.5">{label}</div>
      <div className={`text-lg font-bold ${accent === "warn" ? "text-orange-700" : "text-gray-900"}`}>{value}</div>
    </div>
  );
}
