"use client";

import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import { useTenantId } from "@/lib/useTenant";
import ProductModal, { type Product } from "../_components/ProductModal";
import { formatProductNo, parseProductNo } from "@/lib/format";
import { DataTable, TableHead, Th, SelectTh, SelectTd, TablePagination, EmptyRow, LoadingRow, Badge, PageHeader, PageActionBar, PAGE_ACTION_BAR_SPACER } from "../_components/DataTable";
import Button from "../_components/Button";

type Filter = "all" | "active" | "sale" | "inactive";

const PAGE_SIZE = 300;

const FILTER_OPTIONS: { key: Filter; label: string }[] = [
  { key: "all",      label: "전체" },
  { key: "active",   label: "진행" },
  { key: "sale",     label: "세일" },
  { key: "inactive", label: "품절" },
];

export default function ProductsPage() {
  const [products, setProducts]             = useState<Product[]>([]);
  const [loading, setLoading]               = useState(true);
  const [showModal, setShowModal]           = useState(false);
  const [editing, setEditing]               = useState<Product | null>(null);
  const [inputSearch, setInputSearch]       = useState("");
  const [committedSearch, setCommittedSearch] = useState("");
  const [filter, setFilter]                 = useState<Filter>("all");
  const [selected, setSelected]             = useState<Set<string>>(new Set());
  const [categories, setCategories]         = useState<string[]>([]);
  const [page, setPage]                     = useState(0);
  const [total, setTotal]                   = useState(0);
  const tenantId = useTenantId();
  const [suggestions, setSuggestions]       = useState<{ text: string; productNo: number | null }[]>([]);
  const [showSugg, setShowSugg]             = useState(false);

  useEffect(() => { if (tenantId) fetchCategories(tenantId); }, [tenantId]);
  useEffect(() => { setPage(0); }, [committedSearch, filter]);
  useEffect(() => { if (tenantId) fetchProducts(); }, [committedSearch, filter, page, tenantId]); // eslint-disable-line react-hooks/exhaustive-deps

  // 자동완성 fetch (200ms 디바운스)
  useEffect(() => {
    if (!inputSearch.trim() || !tenantId) { setSuggestions([]); return; }
    const timer = setTimeout(async () => {
      const { data } = await supabase
        .from("products")
        .select("name, product_code, category, product_no")
        .eq("tenant_id", tenantId)
        .or(`name.ilike.%${inputSearch}%,product_code.ilike.%${inputSearch}%,category.ilike.%${inputSearch}%`)
        .limit(10);
      if (!data) return;
      const seen = new Set<string>();
      const items: { text: string; productNo: number | null }[] = [];
      const q = inputSearch.toLowerCase();
      data.forEach(r => {
        if (r.name?.toLowerCase().includes(q) && !seen.has(r.name)) {
          seen.add(r.name); items.push({ text: r.name, productNo: r.product_no ?? null });
        }
        if (r.product_code?.toLowerCase().includes(q) && !seen.has(r.product_code)) {
          seen.add(r.product_code); items.push({ text: r.product_code, productNo: r.product_no ?? null });
        }
        if (r.category?.toLowerCase().includes(q) && !seen.has(r.category)) {
          seen.add(r.category); items.push({ text: r.category, productNo: null });
        }
      });
      setSuggestions(items.slice(0, 8));
    }, 200);
    return () => clearTimeout(timer);
  }, [inputSearch, tenantId]);

  async function fetchCategories(tid: string) {
    const { data } = await supabase.from("product_categories").select("name").eq("tenant_id", tid).order("name");
    if (data) setCategories(data.map(c => c.name));
  }

  async function fetchProducts() {
    if (!tenantId) return;
    setLoading(true);
    let query = supabase
      .from("products")
      .select(
        "id, name, product_no, product_code, category, base_price, cost_price, is_active, is_sale, sale_price, launch_date, product_variants(is_active, is_sale)",
        { count: "planned" },
      )
      .eq("tenant_id", tenantId)
      .order("created_at", { ascending: false })
      .range(page * PAGE_SIZE, (page + 1) * PAGE_SIZE - 1);

    if (committedSearch) {
      const parsedNo = parseProductNo(committedSearch);
      const orParts = [
        `name.ilike.%${committedSearch}%`,
        `product_code.ilike.%${committedSearch}%`,
        `category.ilike.%${committedSearch}%`,
      ];
      if (parsedNo !== null) orParts.push(`product_no.eq.${parsedNo}`);
      query = query.or(orParts.join(","));
    }

    const { data, error, count } = await query;
    if (!error && data) {
      // 옵션(variant) 단위 운영 — derived status:
      //   모든 variants is_active=false → inactive (품절)
      //   active variants 중 1개라도 is_sale=true → sale
      //   그 외 → active
      const mapped = (data as unknown as (Product & { product_variants?: { is_active: boolean; is_sale: boolean }[] })[]).map(p => {
        const variants = p.product_variants ?? [];
        const activeVariants = variants.filter(v => v.is_active);
        const derived: Filter =
          variants.length === 0      ? (p.is_active ? (p.is_sale ? "sale" : "active") : "inactive")
          : activeVariants.length === 0 ? "inactive"
          : activeVariants.some(v => v.is_sale) ? "sale"
          : "active";
        return { ...p, derived_status: derived };
      });
      const filtered = filter === "all" ? mapped : mapped.filter(p => p.derived_status === filter);
      setProducts(filtered);
    }
    setTotal(count ?? 0);
    setLoading(false);
  }

  function handleSearch() {
    setCommittedSearch(inputSearch);
    setShowSugg(false);
  }

  function handleSuggClick(s: { text: string; productNo: number | null }) {
    setInputSearch(s.text);
    setCommittedSearch(s.text);
    setShowSugg(false);
  }

  function clearSearch() {
    setInputSearch("");
    setCommittedSearch("");
    setSuggestions([]);
  }

  function openAdd()  { setEditing(null); setShowModal(true); }
  function openEdit(p: Product) { setEditing(p); setShowModal(true); }
  function closeModal() { setShowModal(false); setEditing(null); }

  async function bulkSetStatus(status: "active" | "sale" | "inactive") {
    if (selected.size === 0) return;
    const ids = Array.from(selected);
    // 옵션 단위 운영: 선택 상품의 모든 variants 일괄 토글
    const variantUpdate =
      status === "active"   ? { is_active: true,  is_sale: false } :
      status === "sale"     ? { is_active: true,  is_sale: true  } :
                              { is_active: false, is_sale: false };
    await supabase.from("product_variants").update(variantUpdate).in("product_id", ids);
    // products.is_active/is_sale 도 동기화 (sale_price 입력 가드 + 다른 페이지 호환)
    await supabase.from("products").update({
      is_active: status !== "inactive",
      is_sale:   status === "sale",
    }).in("id", ids);
    setSelected(new Set());
    fetchProducts();
  }

  async function deleteSelected() {
    if (selected.size === 0) return;
    if (!confirm(`선택한 ${selected.size}개 상품을 삭제하시겠습니까?`)) return;
    await supabase.from("products").delete().in("id", Array.from(selected));
    setSelected(new Set());
    fetchProducts();
  }

  function toggleSelect(id: string) {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const totalPages = Math.ceil(total / PAGE_SIZE);

  return (
    <div className={`flex flex-col ${PAGE_ACTION_BAR_SPACER}`} style={{ height: "calc(100vh - 80px)" }}>

      <PageHeader title="상품 관리" />

      {/* 검색 + 필터 */}
      <div className="flex flex-wrap gap-3 mb-4 flex-shrink-0">
        {/* 검색창 + 자동완성 */}
        <div className="relative">
          <div className="flex gap-2">
            <input
              type="text"
              value={inputSearch}
              onChange={e => { setInputSearch(e.target.value); setShowSugg(true); }}
              onKeyDown={e => {
                if (e.key === "Enter") handleSearch();
                if (e.key === "Escape") setShowSugg(false);
              }}
              onFocus={() => suggestions.length > 0 && setShowSugg(true)}
              onBlur={() => setTimeout(() => setShowSugg(false), 150)}
              placeholder="상품명, 품번, 카테고리, 상품번호 검색"
              className="w-72 input-md"
            />
            <Button onClick={handleSearch}>검색</Button>
            {committedSearch && (
              <button onClick={clearSearch}
                className="px-3 py-2 text-xs text-gray-400 hover:text-gray-600 border border-gray-300 rounded-lg">
                초기화
              </button>
            )}
          </div>
          {/* 자동완성 드롭다운 */}
          {showSugg && suggestions.length > 0 && (
            <div className="absolute top-full left-0 z-30 w-full min-w-[18rem] bg-white border border-gray-200 rounded-lg shadow-lg mt-1 overflow-hidden">
              {suggestions.map((s, i) => (
                <button key={i}
                  onMouseDown={() => handleSuggClick(s)}
                  className="w-full flex items-center justify-between px-4 py-2 text-sm text-gray-700 hover:bg-primary-soft hover:text-primary-hover border-b border-gray-50 last:border-0">
                  <span>{s.text}</span>
                  {s.productNo != null && (
                    <span className="ml-3 font-mono text-xs text-gray-400 shrink-0">
                      {formatProductNo(s.productNo)}
                    </span>
                  )}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* 상태 필터 */}
        <div className="flex rounded-lg border border-gray-300 overflow-hidden text-sm">
          {FILTER_OPTIONS.map(opt => (
            <button key={opt.key} onClick={() => setFilter(opt.key)}
              className={`px-4 py-2 transition-colors ${
                filter === opt.key ? "bg-primary text-white" : "text-gray-600 hover:bg-gray-50"
              }`}>
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      {/* 테이블 */}
      <DataTable
        className="flex-1 min-h-0"
        footer={<TablePagination page={page} totalPages={totalPages} total={total} onPage={setPage} />}
      >
        <TableHead>
          <SelectTh
            checked={selected.size === products.length && products.length > 0}
            onChange={() => {
              if (selected.size === products.length) setSelected(new Set());
              else setSelected(new Set(products.map(p => p.id)));
            }}
          />
          <Th className="w-10 text-gray-500">No</Th>
          <Th>상품번호</Th>
          <Th className="text-gray-500">품번</Th>
          <Th>상품명</Th>
          <Th>카테고리</Th>
          <Th>단가</Th>
          <Th>원가</Th>
          <Th>출시일</Th>
          <Th>상태</Th>
        </TableHead>
        <tbody>
          {loading ? (
            <LoadingRow colSpan={10} />
          ) : products.length === 0 ? (
            <EmptyRow colSpan={10} message="등록된 상품이 없습니다." />
          ) : products.map((p, index) => {
            const ds = (p as Product & { derived_status?: Filter }).derived_status ?? "active";
            const isInactive = ds === "inactive";
            const isSale = ds === "sale";
            return (
            <tr key={p.id} className={`border-b border-gray-100 hover:bg-gray-50 ${isInactive ? "opacity-40" : ""} ${selected.has(p.id) ? "bg-primary-soft" : ""}`}>
              <SelectTd checked={selected.has(p.id)} onToggle={() => toggleSelect(p.id)} />
              <td className="px-3 py-3 text-center text-gray-400 text-xs">{page * PAGE_SIZE + index + 1}</td>
              <td className="px-4 py-3 text-center text-gray-500 font-mono text-xs">
                {formatProductNo((p as unknown as { product_no: number | null }).product_no)}
              </td>
              <td className="px-4 py-3 text-center text-gray-400 text-xs">{p.product_code || "-"}</td>
              <td className="px-4 py-3 font-medium text-primary-hover cursor-pointer hover:underline" onClick={() => openEdit(p)}>
                {p.name}
              </td>
              <td className="px-4 py-3 text-gray-500">{p.category || "-"}</td>
              <td className="px-4 py-3 text-right">
                {isSale && p.sale_price ? (
                  <div>
                    <p className="line-through text-gray-400 text-xs">{p.base_price.toLocaleString()}</p>
                    <p className="text-red-500 font-medium">{p.sale_price.toLocaleString()}</p>
                  </div>
                ) : <p className="text-gray-700">{p.base_price.toLocaleString()}</p>}
              </td>
              <td className="px-4 py-3 text-right text-gray-500">
                {p.cost_price ? p.cost_price.toLocaleString() : "-"}
              </td>
              <td className="px-4 py-3 text-center text-gray-500">{p.launch_date || "-"}</td>
              <td className="px-4 py-3 text-center">
                <Badge color={isInactive ? "gray" : isSale ? "orange" : "green"}>
                  {isInactive ? "품절" : isSale ? "세일" : "진행"}
                </Badge>
              </td>
            </tr>
            );
          })}
        </tbody>
      </DataTable>

      {showModal && (
        <ProductModal
          editing={editing}
          categories={categories}
          onClose={closeModal}
          onSaved={() => { closeModal(); fetchProducts(); }}
          onCategoryAdded={name => setCategories(prev => [...new Set([...prev, name])].sort())}
        />
      )}

      <PageActionBar>
        {selected.size > 0 && (
          <>
            <button onClick={() => bulkSetStatus("active")}
              className="px-3 py-2 bg-green-100 text-green-700 text-sm rounded-lg hover:bg-green-200">
              진행 ({selected.size})
            </button>
            <button onClick={() => bulkSetStatus("sale")}
              className="px-3 py-2 bg-orange-100 text-orange-600 text-sm rounded-lg hover:bg-orange-200">
              세일 ({selected.size})
            </button>
            <button onClick={() => bulkSetStatus("inactive")}
              className="px-3 py-2 bg-gray-100 text-gray-500 text-sm rounded-lg hover:bg-gray-200">
              품절 ({selected.size})
            </button>
            <Button variant="danger" size="sm" onClick={deleteSelected}>삭제 ({selected.size})</Button>
          </>
        )}
        <Button onClick={openAdd}>+ 상품 등록</Button>
      </PageActionBar>
    </div>
  );
}
