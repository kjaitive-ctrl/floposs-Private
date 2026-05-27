"use client";

import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import { useTenantId } from "@/lib/useTenant";
import CustomerModal, { type Customer } from "../_components/CustomerModal";
import SearchFilterBar from "../_components/SearchFilterBar";
import { DataTable, TableHead, Th, TablePagination, EmptyRow, LoadingRow, PageHeader, PageActionBar, PAGE_ACTION_BAR_SPACER } from "../_components/DataTable";
import { useSearchSuggestions } from "../_hooks/useSearchSuggestions";
import Button from "../_components/Button";
import { displayOutstanding } from "@/lib/format";

const PAGE_SIZE = 50;

export default function CustomersPage() {
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [loading, setLoading] = useState(true);
  const [showModal, setShowModal] = useState(false);
  const [editing, setEditing] = useState<Customer | null>(null);
  const [committedSearch, setCommittedSearch] = useState("");
  const [page, setPage] = useState(0);
  const [total, setTotal] = useState(0);
  const tenantId = useTenantId();
  const [suggestions, handleQueryChange] = useSearchSuggestions(async q => {
    if (!tenantId) return [];
    const { data } = await supabase
      .from("customers")
      .select("company_name, owner_name")
      .eq("tenant_id", tenantId)
      .or(`company_name.ilike.%${q}%,owner_name.ilike.%${q}%`)
      .limit(8);
    if (!data) return [];
    const seen = new Set<string>();
    const items = [];
    for (const r of data) {
      if (r.company_name && !seen.has(r.company_name)) { seen.add(r.company_name); items.push({ text: r.company_name }); }
      if (r.owner_name && !seen.has(r.owner_name)) { seen.add(r.owner_name); items.push({ text: r.owner_name }); }
    }
    return items.slice(0, 8);
  });

  useEffect(() => { setPage(0); }, [committedSearch]);
  useEffect(() => { if (tenantId) fetchCustomers(); }, [committedSearch, page, tenantId]); // eslint-disable-line react-hooks/exhaustive-deps

  async function fetchCustomers() {
    setLoading(true);
    let query = supabase
      .from("customers")
      .select(
        "id, company_name, business_name, outstanding_balance, outstanding_vat, credit_limit, include_vat, default_payment_method, contact1_phone, contact2_phone, buyer_phone, buyer_name, created_at, owner_name, phone, business_number, address, is_active, linked_tenant_id",
        { count: "exact" }
      )
      .eq("tenant_id", tenantId)
      .order("created_at", { ascending: false })
      .range(page * PAGE_SIZE, (page + 1) * PAGE_SIZE - 1);

    if (committedSearch) {
      query = query.or(`company_name.ilike.%${committedSearch}%,owner_name.ilike.%${committedSearch}%,phone.ilike.%${committedSearch}%,business_number.ilike.%${committedSearch}%`);
    }
    const { data, error, count } = await query;
    if (!error && data) setCustomers(data as unknown as Customer[]);
    setTotal(count ?? 0);
    setLoading(false);
  }

  function openAdd() { setEditing(null); setShowModal(true); }
  function openEdit(c: Customer) { setEditing(c); setShowModal(true); }
  function closeModal() { setShowModal(false); setEditing(null); }

  // "삭제" = is_active=false 비활성화 (사장 정책 2026-05-15).
  //   - 영수증/매출/외상 박제 그대로 유지 (DB row 영구 보존)
  //   - 거래이력 있어도 가능 — 사용 중단 의미만 표시
  //   - 재활성화는 미래 작업 또는 super_admin 권한
  async function handleDelete(id: string, companyName: string, isActive: boolean) {
    if (!isActive) {
      if (!confirm(`'${companyName}' 거래처를 다시 활성화하시겠습니까?`)) return;
      const { error } = await supabase.from("customers").update({ is_active: true }).eq("id", id);
      if (error) { alert(error.message); return; }
      fetchCustomers();
      return;
    }
    if (!confirm(`'${companyName}' 거래처를 비활성화하시겠습니까?\n\n· DB 데이터(영수증/매출/외상) 는 그대로 유지됩니다.\n· 더 이상 새 거래 등록 시 선택되지 않습니다.`)) return;
    const { error } = await supabase.from("customers").update({ is_active: false }).eq("id", id);
    if (error) { alert(error.message); return; }
    fetchCustomers();
  }

  // include_vat 은 payment_method 종속 — 수동 토글 제거 (관리자 정책 2026-05-11).
  // 변경하려면 거래처 수정 모달에서 결제방식 변경.

  const totalPages = Math.ceil(total / PAGE_SIZE);

  return (
    <div className={PAGE_ACTION_BAR_SPACER}>
      <PageHeader title="거래처 관리" />

      <SearchFilterBar
        onSearch={q => { setCommittedSearch(q); setPage(0); }}
        onQueryChange={handleQueryChange}
        suggestions={suggestions}
        placeholder="업체명, 담당자, 전화번호, 사업자번호 검색"
      />

      <DataTable footer={<TablePagination page={page} totalPages={totalPages} total={total} onPage={setPage} />}>
        <TableHead>
          <Th className="w-10 text-gray-500">No</Th>
          <Th>업체명</Th>
          <Th>사업자상호명</Th>
          <Th>주문담당 연락처</Th>
          <Th>물류담당 연락처</Th>
          <Th>사입자번호</Th>
          <Th>외상한도</Th>
          <Th>미수금</Th>
          <Th>한도사용률</Th>
          <Th>결제방식</Th>
          <Th>결제시 세액</Th>
          <Th>관리</Th>
        </TableHead>
          <tbody>
            {loading ? (
              <LoadingRow colSpan={12} />
            ) : customers.length === 0 ? (
              <EmptyRow colSpan={12} message="등록된 거래처가 없습니다." />
            ) : customers.map((c, index) => {
              // 외상 with_vat 표시 (청구거래처 = include_vat ON 이면 supply + vat 합산)
              const outstandingDisplay = displayOutstanding(c);
              const usageRate = c.credit_limit > 0
                ? Math.min(Math.round((outstandingDisplay / c.credit_limit) * 100), 100)
                : 0;
              const rateColor = usageRate >= 90 ? "bg-red-500" : usageRate >= 60 ? "bg-yellow-400" : "bg-primary-ring";
              return (
                <tr key={c.id} className={`border-b border-gray-100 hover:bg-gray-50 ${c.is_active ? "" : "bg-gray-50 text-gray-400"}`}>
                  <td className="px-3 py-3 text-center text-gray-400 text-xs">{page * PAGE_SIZE + index + 1}</td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <p className={`font-medium ${c.is_active ? "text-gray-900" : "text-gray-400 line-through"}`}>{c.company_name}</p>
                      {!c.is_active && (
                        <span className="px-1.5 py-0.5 text-[10px] font-semibold rounded bg-gray-200 text-gray-500 border border-gray-300">
                          비활성
                        </span>
                      )}
                      {c.linked_tenant_id && (
                        <span
                          title="retail 연동 거래처 — 결제수단 변경 권한이 retail 측에만"
                          className="px-1.5 py-0.5 text-[10px] font-semibold rounded bg-sky-100 text-sky-700 border border-sky-200"
                        >
                          연동
                        </span>
                      )}
                    </div>
                  </td>
                  <td className="px-4 py-3 text-gray-600 text-sm">{c.business_name || "-"}</td>
                  <td className="px-4 py-3 text-gray-600 text-sm">{c.contact1_phone || "-"}</td>
                  <td className="px-4 py-3 text-gray-600 text-sm">{c.contact2_phone || "-"}</td>
                  <td className="px-4 py-3 text-gray-600 text-sm">
                    {c.buyer_phone ? (
                      <>
                        <p>{c.buyer_phone}</p>
                        {c.buyer_name && <p className="text-xs text-gray-400">{c.buyer_name}</p>}
                      </>
                    ) : "-"}
                  </td>
                  <td className="px-4 py-3 text-right text-gray-600">{c.credit_limit.toLocaleString()}</td>
                  <td className="px-4 py-3 text-right">
                    <span className={`font-medium ${
                      outstandingDisplay > 0 ? "text-red-500" :
                      outstandingDisplay < 0 ? "text-primary-ring" : "text-gray-600"
                    }`}>
                      {outstandingDisplay < 0 ? "매입 " : ""}
                      {Math.abs(outstandingDisplay).toLocaleString()}
                    </span>
                    {c.include_vat && (c.outstanding_vat ?? 0) > 0 && (
                      <p className="text-[10px] text-gray-400 mt-0.5">
                        부가세 {(c.outstanding_vat ?? 0).toLocaleString()}
                      </p>
                    )}
                  </td>
                  <td className="px-4 py-3 text-center">
                    {c.credit_limit > 0 && outstandingDisplay > 0 ? (
                      <div className="flex items-center justify-center gap-1">
                        <div className="w-16 bg-gray-200 rounded-full h-1.5">
                          <div className={`h-1.5 rounded-full ${rateColor}`} style={{ width: `${usageRate}%` }} />
                        </div>
                        <span className={`text-xs font-medium ${usageRate >= 90 ? "text-red-500" : "text-gray-500"}`}>
                          {usageRate}%
                        </span>
                      </div>
                    ) : <span className="text-xs text-gray-300">-</span>}
                  </td>
                  <td className="px-4 py-3 text-center">
                    {(() => {
                      const m = c.default_payment_method ?? "cash";
                      const cfg = m === "cash" ? { label: "현금", cls: "bg-cash-soft text-cash-hover border-cash-border" }
                               : m === "transfer" ? { label: "통장", cls: "bg-transfer-soft text-transfer-hover border-transfer-border" }
                               : { label: "청구", cls: "bg-credit-soft text-credit-hover border-credit-border" };
                      return (
                        <div className="flex items-center justify-center gap-1">
                          <span className={`px-2 py-0.5 text-xs font-medium rounded border ${cfg.cls}`}>{cfg.label}</span>
                          {c.linked_tenant_id && (
                            <span
                              title="retail 연동 — wholesale 측 변경 불가"
                              className="px-1.5 py-0.5 text-[10px] font-semibold rounded bg-sky-100 text-sky-700 border border-sky-200"
                            >
                              연동
                            </span>
                          )}
                        </div>
                      );
                    })()}
                  </td>
                  <td className="px-4 py-3 text-center">
                    <p className="text-xs text-gray-500">{c.include_vat ? "부가세 포함" : "부가세 제외"}</p>
                  </td>
                  <td className="px-4 py-3 text-center space-x-2">
                    <button onClick={() => openEdit(c)} className="text-primary hover:underline text-xs">수정</button>
                    <button
                      onClick={() => handleDelete(c.id, c.company_name, c.is_active)}
                      className={c.is_active ? "text-red-500 hover:underline text-xs" : "text-emerald-600 hover:underline text-xs"}
                    >
                      {c.is_active ? "비활성화" : "재활성화"}
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
      </DataTable>

      {showModal && (
        <CustomerModal
          editing={editing}
          onClose={closeModal}
          onSaved={() => { closeModal(); fetchCustomers(); }}
        />
      )}

      <PageActionBar>
        <Button onClick={openAdd}>+ 거래처 등록</Button>
      </PageActionBar>
    </div>
  );
}
