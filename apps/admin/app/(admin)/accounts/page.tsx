"use client";

import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import { krw, formatDate } from "@/lib/format";
import { Modal } from "@floposs/ui";

const ADMIN_EMAIL = "admin@kjretail.com";

const CATEGORY_LABEL: Record<string, string> = {
  wholesale: "도매거래처",
  supplies: "소모품업체",
  restaurant: "음식점",
  manufacturer: "제조사",
  other: "기타",
};
const CATEGORIES = Object.entries(CATEGORY_LABEL);

type Plan = { id: string; name: string; price: number; billing_cycle: string; vertical: string };

type TenantStatus = "pending" | "active" | "suspended";

// 2026-05-14 admin 3탭 (멀티업종 SaaS, [[project_multi_vertical_saas]])
//   Wholesale = 핵심 매출, Retail = 다수 가입, 그 외 = 5축 가치사슬 +@
//   tenant_type 기준 필터링 (legacy category 와 별개)
type TenantTypeTab = "wholesale" | "retail" | "others";
const TENANT_TYPE_TABS: { key: TenantTypeTab; label: string }[] = [
  { key: "wholesale", label: "도매" },
  { key: "retail",    label: "소매" },
  { key: "others",    label: "그 외 +@" },
];

type TenantUser = {
  id: string;
  email: string;
  name: string | null;
  role: string;
  memo: string | null;
  is_active: boolean;
  last_login_at: string | null;
  created_at: string;
  created_by: string | null;
};

type Tenant = {
  id: string;
  company_name: string;
  business_number: string | null;
  owner_name: string | null;
  phone: string | null;
  address: string | null;
  tenant_type: string;    // 'wholesale' | 'retail' | 'logistics' | 'designer' | 'platform' | 'restaurant' | 'other'
  category: string;       // legacy: wholesale 내부 sub-classification
  admin_note: string | null;
  is_active: boolean;
  status: TenantStatus;
  plan_id: string | null;
  subscription_expires_at: string | null;
  created_at: string;
  subscription_plans: { name: string; price: number } | null;
  users: TenantUser[];
};

// 사장(tenant_admin) user 1건 — 첫 user 가 아니라 role 로 정확히 뽑는다.
function ownerOf(t: Tenant): TenantUser | undefined {
  return t.users.find(u => u.role === "tenant_admin");
}

const emptyForm = {
  email: "",
  password: "",
  company_name: "",
  business_number: "",
  owner_name: "",
  phone: "",
  address: "",
  category: "wholesale",
  plan_id: "",
  subscription_expires_at: "",
  admin_note: "",
};

export default function AccountsPage() {
  const [tenants, setTenants] = useState<Tenant[]>([]);
  const [plans, setPlans] = useState<Plan[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [categoryFilter, setCategoryFilter] = useState("all");

  const [statusFilter, setStatusFilter] = useState<"all" | TenantStatus>("all");
  const [tenantTypeTab, setTenantTypeTab] = useState<TenantTypeTab>("wholesale");
  const [showModal, setShowModal] = useState(false);
  const [editing, setEditing] = useState<Tenant | null>(null);
  const [form, setForm] = useState(emptyForm);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [staffViewing, setStaffViewing] = useState<Tenant | null>(null);

  useEffect(() => {
    fetchAll();
  }, []);

  async function fetchAll() {
    setLoading(true);
    const [{ data: tenantData }, { data: planData }] = await Promise.all([
      supabase
        .from("tenants")
        .select("*, subscription_plans(name, price), users(id, email, name, role, memo, is_active, last_login_at, created_at, created_by)")
        .order("created_at", { ascending: false }),
      supabase.from("subscription_plans").select("id, name, price, billing_cycle, vertical").eq("is_active", true).order("sort_order"),
    ]);

    if (planData) setPlans(planData);
    if (tenantData) {
      // admin(super_admin) 자기 자신 tenant 제외
      const filtered = (tenantData as unknown as Tenant[]).filter(
        t => !t.users.some(u => u.email === ADMIN_EMAIL)
      );
      setTenants(filtered);
    }
    setLoading(false);
  }

  function openAdd() {
    setEditing(null);
    setForm(emptyForm);
    setError("");
    setShowModal(true);
  }

  function openEdit(t: Tenant) {
    setEditing(t);
    setForm({
      email: ownerOf(t)?.email || "",
      password: "",
      company_name: t.company_name,
      business_number: t.business_number || "",
      owner_name: t.owner_name || "",
      phone: t.phone || "",
      address: t.address || "",
      category: t.category,
      plan_id: t.plan_id || "",
      subscription_expires_at: t.subscription_expires_at
        ? t.subscription_expires_at.slice(0, 10)
        : "",
      admin_note: t.admin_note || "",
    });
    setError("");
    setShowModal(true);
  }

  async function handleSave() {
    if (!form.company_name.trim()) return setError("업체명을 입력해주세요.");
    if (!editing && !form.email.trim()) return setError("이메일을 입력해주세요.");
    if (!editing && !form.password.trim()) return setError("비밀번호를 입력해주세요.");
    setSaving(true);
    setError("");

    if (!editing) {
      // 신규 계정 생성 — API route 호출
      const { data: { session } } = await supabase.auth.getSession();
      const res = await fetch("/api/admin/create-user", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${session?.access_token}`,
        },
        body: JSON.stringify({
          email: form.email,
          password: form.password,
          company_name: form.company_name,
          business_number: form.business_number || null,
          owner_name: form.owner_name || null,
          phone: form.phone || null,
          address: form.address || null,
          category: form.category,
          plan_id: form.plan_id || null,
          subscription_expires_at: form.subscription_expires_at || null,
          admin_note: form.admin_note || null,
        }),
      });
      const result = await res.json();
      if (!res.ok) { setError(result.error || "계정 생성 실패"); setSaving(false); return; }
    } else {
      // 기존 테넌트 정보 수정
      const { error } = await supabase.from("tenants").update({
        company_name: form.company_name,
        business_number: form.business_number || null,
        owner_name: form.owner_name || null,
        phone: form.phone || null,
        address: form.address || null,
        category: form.category,
        plan_id: form.plan_id || null,
        subscription_expires_at: form.subscription_expires_at || null,
        admin_note: form.admin_note || null,
      }).eq("id", editing.id);
      if (error) { setError(error.message); setSaving(false); return; }
    }

    setSaving(false);
    setShowModal(false);
    fetchAll();
  }

  // status 전이 — pending/suspended → active (승인/재활성), active → suspended (정지)
  // is_active 는 legacy 컬럼이지만 일관성 유지 위해 동기화.
  async function changeStatus(t: Tenant, next: TenantStatus) {
    const verbs: Record<TenantStatus, string> = {
      active: "활성화",
      suspended: "정지",
      pending: "대기",
    };
    if (!confirm(`"${t.company_name}" 계정을 ${verbs[next]} 처리하시겠습니까?`)) return;

    const isActive = next === "active";
    const { error } = await supabase
      .from("tenants")
      .update({ status: next, is_active: isActive })
      .eq("id", t.id);
    if (error) { alert("처리 실패: " + error.message); return; }
    setTenants(prev => prev.map(x => x.id === t.id ? { ...x, status: next, is_active: isActive } : x));
  }

  async function deleteTenant(t: Tenant) {
    if (!confirm(`"${t.company_name}" 계정을 삭제하시겠습니까?\n삭제하면 모든 데이터가 사라집니다.`)) return;
    await supabase.from("tenants").delete().eq("id", t.id);
    setTenants(prev => prev.filter(x => x.id !== t.id));
  }

  // 3탭 분류 함수 — wholesale/retail 외는 모두 "그 외"
  function matchTenantTypeTab(t: Tenant, tab: TenantTypeTab): boolean {
    if (tab === "wholesale") return t.tenant_type === "wholesale";
    if (tab === "retail")    return t.tenant_type === "retail";
    return t.tenant_type !== "wholesale" && t.tenant_type !== "retail";
  }

  const tabScoped = tenants.filter(t => matchTenantTypeTab(t, tenantTypeTab));

  const filtered = tabScoped
    .filter(t => statusFilter === "all" || t.status === statusFilter)
    .filter(t => categoryFilter === "all" || t.category === categoryFilter)
    .filter(t =>
      t.company_name.includes(search) ||
      (ownerOf(t)?.email || "").includes(search) ||
      (t.owner_name || "").includes(search)
    );

  // 탭별 카운트 (전체 tenants 기준)
  const wholesaleCount = tenants.filter(t => matchTenantTypeTab(t, "wholesale")).length;
  const retailCount    = tenants.filter(t => matchTenantTypeTab(t, "retail")).length;
  const othersCount    = tenants.filter(t => matchTenantTypeTab(t, "others")).length;

  // status 카운트 (현 탭 scope 안에서)
  const pendingCount   = tabScoped.filter(t => t.status === "pending").length;
  const activeCount    = tabScoped.filter(t => t.status === "active").length;
  const suspendedCount = tabScoped.filter(t => t.status === "suspended").length;

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className="text-2xl font-bold text-gray-900">계정관리</h2>
          <p className="text-sm text-gray-500 mt-0.5">총 {tenants.length}개 계정</p>
        </div>
        {/* admin 직접 등록은 wholesale 만. retail/그외는 self-signup. */}
        {tenantTypeTab === "wholesale" ? (
          <button onClick={openAdd}
            className="px-4 py-2 bg-primary text-white text-sm rounded-lg hover:bg-primary-hover">
            + 계정 등록
          </button>
        ) : (
          <span className="text-xs text-gray-400">
            {tenantTypeTab === "retail" ? "소매" : "그 외"} 가입은 self-signup (/login)
          </span>
        )}
      </div>

      {/* 요약 카드 */}
      <div className="grid grid-cols-5 gap-4 mb-6">
        {[
          { label: "전체 계정", value: `${tenants.length}개` },
          { label: "승인 대기", value: `${pendingCount}개`, color: "text-orange-500" },
          { label: "활성", value: `${activeCount}개`, color: "text-green-600" },
          { label: "정지", value: `${suspendedCount}개`, color: "text-red-500" },
          { label: "이번달 만료 예정", value: `${tenants.filter(t => {
            if (!t.subscription_expires_at) return false;
            const exp = new Date(t.subscription_expires_at);
            const now = new Date();
            return exp.getFullYear() === now.getFullYear() && exp.getMonth() === now.getMonth();
          }).length}개`, color: "text-orange-500" },
        ].map(c => (
          <div key={c.label} className="bg-white rounded-xl border border-gray-200 px-4 py-3">
            <p className="text-xs text-gray-500">{c.label}</p>
            <p className={`text-xl font-bold mt-1 ${c.color ?? "text-gray-900"}`}>{c.value}</p>
          </div>
        ))}
      </div>

      {/* tenant_type 3탭 (멀티업종 SaaS 분류) */}
      <div className="flex gap-1 mb-4 border-b border-gray-200">
        {TENANT_TYPE_TABS.map(tab => {
          const count = tab.key === "wholesale" ? wholesaleCount
            : tab.key === "retail" ? retailCount
            : othersCount;
          const active = tenantTypeTab === tab.key;
          return (
            <button
              key={tab.key}
              onClick={() => setTenantTypeTab(tab.key)}
              className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
                active
                  ? "border-primary text-primary"
                  : "border-transparent text-gray-500 hover:text-gray-700"
              }`}
            >
              {tab.label}
              <span className={`ml-1.5 text-xs ${active ? "text-primary" : "text-gray-400"}`}>
                ({count})
              </span>
            </button>
          );
        })}
      </div>

      {/* 상태 필터 */}
      <div className="flex gap-2 mb-3">
        {([
          { key: "all", label: "전체" },
          { key: "pending", label: `대기 ${pendingCount}` },
          { key: "active", label: `활성 ${activeCount}` },
          { key: "suspended", label: `정지 ${suspendedCount}` },
        ] as const).map(s => (
          <button key={s.key} onClick={() => setStatusFilter(s.key)}
            className={`px-3 py-1.5 rounded-lg text-sm transition-colors ${
              statusFilter === s.key
                ? "bg-primary text-white"
                : "bg-white border border-gray-300 text-gray-600 hover:bg-gray-50"
            }`}>
            {s.label}
          </button>
        ))}
      </div>

      {/* 검색 + 분류 필터 */}
      <div className="flex gap-3 mb-4">
        <input type="text" placeholder="업체명, 이메일, 대표자명 검색" value={search}
          onChange={e => setSearch(e.target.value)}
          className="w-64 input-md" />
        <div className="flex rounded-lg border border-gray-300 overflow-hidden text-sm">
          <button onClick={() => setCategoryFilter("all")}
            className={`px-3 py-2 transition-colors ${categoryFilter === "all" ? "bg-primary text-white" : "text-gray-600 hover:bg-gray-50"}`}>
            전체
          </button>
          {CATEGORIES.map(([key, label]) => (
            <button key={key} onClick={() => setCategoryFilter(key)}
              className={`px-3 py-2 transition-colors ${categoryFilter === key ? "bg-primary text-white" : "text-gray-600 hover:bg-gray-50"}`}>
              {label}
            </button>
          ))}
        </div>
      </div>

      {/* 계정 테이블 */}
      <div className="bg-white rounded-xl border border-gray-200 overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 border-b border-gray-200">
            <tr>
              <th className="text-left px-4 py-3 text-gray-600 font-medium">업체명</th>
              <th className="text-left px-4 py-3 text-gray-600 font-medium">사장 이메일</th>
              <th className="text-center px-4 py-3 text-gray-600 font-medium">분류</th>
              <th className="text-left px-4 py-3 text-gray-600 font-medium">대표자</th>
              <th className="text-center px-4 py-3 text-gray-600 font-medium">직원</th>
              <th className="text-center px-4 py-3 text-gray-600 font-medium">플랜</th>
              <th className="text-center px-4 py-3 text-gray-600 font-medium">만료일</th>
              <th className="text-center px-4 py-3 text-gray-600 font-medium">상태</th>
              <th className="text-center px-4 py-3 text-gray-600 font-medium">가입일</th>
              <th className="text-center px-4 py-3 text-gray-600 font-medium">관리</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={10} className="text-center py-10 text-gray-400">불러오는 중...</td></tr>
            ) : filtered.length === 0 ? (
              <tr><td colSpan={10} className="text-center py-10 text-gray-400">계정이 없습니다.</td></tr>
            ) : filtered.map(t => {
              const staff = t.users.filter(u => u.role === "staff" || u.role === "manager");
              const activeStaff = staff.filter(u => u.is_active).length;
              return (
              <tr key={t.id} className={`border-b border-gray-100 hover:bg-gray-50 ${t.status !== "active" ? "opacity-60" : ""}`}>
                <td className="px-4 py-3 font-medium text-gray-900">{t.company_name}</td>
                <td className="px-4 py-3 text-gray-600 text-xs">{ownerOf(t)?.email || "-"}</td>
                <td className="px-4 py-3 text-center">
                  <span className="text-xs px-2 py-0.5 bg-primary-soft text-primary-hover rounded-full">
                    {t.tenant_type === "wholesale"
                      ? (CATEGORY_LABEL[t.category] ?? t.category)
                      : t.tenant_type === "retail"
                        ? "소매"
                        : t.tenant_type}
                  </span>
                </td>
                <td className="px-4 py-3 text-gray-600">{t.owner_name || "-"}</td>
                <td className="px-4 py-3 text-center">
                  {staff.length === 0 ? (
                    <span className="text-xs text-gray-400">없음</span>
                  ) : (
                    <button
                      onClick={() => setStaffViewing(t)}
                      className="text-xs px-2.5 py-1 border border-gray-300 rounded-lg text-gray-700 hover:bg-gray-50"
                      title="직원 목록 보기"
                    >
                      {activeStaff}/{staff.length}명
                    </button>
                  )}
                </td>
                <td className="px-4 py-3 text-center text-xs text-gray-600">
                  {t.subscription_plans?.name || "-"}
                  {t.subscription_plans?.price ? (
                    <span className="ml-1 text-gray-400">{krw(t.subscription_plans.price)}</span>
                  ) : null}
                </td>
                <td className="px-4 py-3 text-center text-xs text-gray-500">
                  {t.subscription_expires_at ? formatDate(t.subscription_expires_at) : "-"}
                </td>
                <td className="px-4 py-3 text-center">
                  <StatusBadge status={t.status} />
                </td>
                <td className="px-4 py-3 text-center text-xs text-gray-400">{formatDate(t.created_at)}</td>
                <td className="px-4 py-3 text-center">
                  <div className="flex gap-1 justify-center">
                    <button onClick={() => openEdit(t)}
                      className="text-xs px-2.5 py-1 border border-gray-300 rounded-lg text-gray-600 hover:bg-gray-50">
                      수정
                    </button>
                    {t.status === "pending" && (
                      <button onClick={() => changeStatus(t, "active")}
                        className="text-xs px-2.5 py-1 border border-green-300 text-green-600 rounded-lg hover:bg-green-50 font-medium">
                        승인
                      </button>
                    )}
                    {t.status === "active" && (
                      <button onClick={() => changeStatus(t, "suspended")}
                        className="text-xs px-2.5 py-1 border border-orange-300 text-orange-600 rounded-lg hover:bg-orange-50">
                        정지
                      </button>
                    )}
                    {t.status === "suspended" && (
                      <button onClick={() => changeStatus(t, "active")}
                        className="text-xs px-2.5 py-1 border border-green-300 text-green-600 rounded-lg hover:bg-green-50">
                        재활성화
                      </button>
                    )}
                    <button onClick={() => deleteTenant(t)}
                      className="text-xs px-2.5 py-1 border border-red-300 text-red-500 rounded-lg hover:bg-red-50">
                      삭제
                    </button>
                  </div>
                </td>
              </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* 계정 등록/수정 모달 */}
      {showModal && (
        <Modal onClose={() => !saving && setShowModal(false)} size="xl">
          <div className="p-5 border-b border-gray-100">
            <h3 className="text-lg font-bold text-gray-900">{editing ? "계정 수정" : "계정 등록"}</h3>
          </div>
          <div className="p-5 space-y-4">

            {/* 로그인 정보 (신규만) */}
            {!editing && (
              <div className="p-4 bg-primary-soft rounded-xl space-y-3">
                <p className="text-xs font-semibold text-primary-hover uppercase">로그인 정보</p>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs text-gray-600 mb-1">이메일 *</label>
                    <input type="email" value={form.email} onChange={e => setForm(f => ({ ...f, email: e.target.value }))}
                      className="w-full input-md" />
                  </div>
                  <div>
                    <label className="block text-xs text-gray-600 mb-1">임시 비밀번호 *</label>
                    <input type="text" value={form.password} onChange={e => setForm(f => ({ ...f, password: e.target.value }))}
                      placeholder="초기 비밀번호"
                      className="w-full input-md" />
                  </div>
                </div>
              </div>
            )}
            {editing && (
              <>
                <div className="px-3 py-2 bg-gray-50 rounded-lg text-sm text-gray-500">
                  이메일: <span className="font-medium text-gray-800">{form.email}</span>
                </div>
                <PasswordResetSection email={form.email} />
              </>
            )}

            {/* 사업자 정보 */}
            <div className="space-y-3">
              <p className="text-xs font-semibold text-gray-500 uppercase">사업자 정보</p>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs text-gray-600 mb-1">업체명 *</label>
                  <input type="text" value={form.company_name} onChange={e => setForm(f => ({ ...f, company_name: e.target.value }))}
                    className="w-full input-md" />
                </div>
                <div>
                  <label className="block text-xs text-gray-600 mb-1">사업자번호</label>
                  <input type="text" value={form.business_number} onChange={e => setForm(f => ({ ...f, business_number: e.target.value }))}
                    placeholder="000-00-00000"
                    className="w-full input-md" />
                </div>
                <div>
                  <label className="block text-xs text-gray-600 mb-1">대표자명</label>
                  <input type="text" value={form.owner_name} onChange={e => setForm(f => ({ ...f, owner_name: e.target.value }))}
                    className="w-full input-md" />
                </div>
                <div>
                  <label className="block text-xs text-gray-600 mb-1">연락처</label>
                  <input type="text" value={form.phone} onChange={e => setForm(f => ({ ...f, phone: e.target.value }))}
                    className="w-full input-md" />
                </div>
                <div className="col-span-2">
                  <label className="block text-xs text-gray-600 mb-1">주소</label>
                  <input type="text" value={form.address} onChange={e => setForm(f => ({ ...f, address: e.target.value }))}
                    className="w-full input-md" />
                </div>
              </div>
            </div>

            {/* 분류 + 구독 */}
            <div className="space-y-3">
              <p className="text-xs font-semibold text-gray-500 uppercase">분류 및 구독</p>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs text-gray-600 mb-1">분류</label>
                  <select value={form.category} onChange={e => setForm(f => ({ ...f, category: e.target.value }))}
                    className="w-full input-md">
                    {CATEGORIES.map(([key, label]) => (
                      <option key={key} value={key}>{label}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-xs text-gray-600 mb-1">
                    구독 플랜
                    <span className="text-gray-400 ml-1">({editing?.tenant_type ?? "wholesale"} vertical)</span>
                  </label>
                  <select value={form.plan_id} onChange={e => setForm(f => ({ ...f, plan_id: e.target.value }))}
                    className="w-full input-md">
                    <option value="">플랜 없음</option>
                    {plans
                      .filter(p => p.vertical === (editing?.tenant_type ?? "wholesale"))
                      .map(p => (
                        <option key={p.id} value={p.id}>{p.name} — {krw(p.price)}/{p.billing_cycle === "monthly" ? "월" : "년"}</option>
                      ))}
                  </select>
                </div>
                <div>
                  <label className="block text-xs text-gray-600 mb-1">구독 만료일</label>
                  <input type="date" value={form.subscription_expires_at} onChange={e => setForm(f => ({ ...f, subscription_expires_at: e.target.value }))}
                    className="w-full input-md" />
                </div>
              </div>
            </div>

            {/* 어드민 메모 */}
            <div>
              <label className="block text-xs text-gray-600 mb-1">관리자 메모</label>
              <textarea value={form.admin_note} onChange={e => setForm(f => ({ ...f, admin_note: e.target.value }))}
                rows={2} placeholder="내부 메모 (이용자에게 보이지 않음)"
                className="w-full input-md resize-none" />
            </div>

            {error && <p className="text-sm text-red-500">{error}</p>}
          </div>
          <div className="flex gap-2 p-5 border-t border-gray-100">
            <button onClick={() => setShowModal(false)} disabled={saving}
              className="flex-1 py-2.5 border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50 text-sm">
              취소
            </button>
            <button onClick={handleSave} disabled={saving}
              className="flex-1 py-2.5 bg-primary text-white rounded-lg hover:bg-primary-hover disabled:opacity-50 font-medium text-sm">
              {saving ? "처리 중..." : editing ? "수정 완료" : "계정 등록"}
            </button>
          </div>
        </Modal>
      )}

      {/* 직원 목록 모달 (read-only) */}
      {staffViewing && (
        <StaffListModal tenant={staffViewing} onClose={() => setStaffViewing(null)} />
      )}
    </div>
  );
}

// admin 이 보는 직원 목록 — 사장 dashboard 의 staff section 과 동일 정보, 단 read-only.
// (직원 비활성화는 사장이 직접 — admin 이 끼어들면 사장이 모르고 헷갈림)
function StaffListModal({ tenant, onClose }: { tenant: Tenant; onClose: () => void }) {
  const staff = tenant.users.filter(u => u.role === "staff" || u.role === "manager");
  // 생성자 이름 lookup — 같은 tenant 의 tenant_admin 들 중에서
  const userById = new Map(tenant.users.map(u => [u.id, u]));
  return (
    <Modal onClose={onClose} size="lg">
      <div className="p-5 border-b border-gray-100">
        <h3 className="text-lg font-bold text-gray-900">{tenant.company_name} — 직원/매니저 목록</h3>
        <p className="text-xs text-gray-500 mt-0.5">총 {staff.length}명 (활성 {staff.filter(u => u.is_active).length}명)</p>
      </div>
      <div className="p-5">
        {staff.length === 0 ? (
          <p className="text-center text-sm text-gray-400 py-8">등록된 직원/매니저가 없습니다.</p>
        ) : (
          <ul className="space-y-2">
            {staff.map(u => {
              const creator = u.created_by ? userById.get(u.created_by) : null;
              const creatorLabel = creator ? (creator.name ?? creator.email) : null;
              const roleLabel = u.role === "manager" ? "매니저" : "직원";
              return (
              <li
                key={u.id}
                className={`flex items-start justify-between px-3 py-2 rounded-lg border gap-3 ${
                  u.is_active ? "bg-white border-gray-200" : "bg-gray-50 border-gray-200 opacity-60"
                }`}
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-sm text-gray-900">{u.name || "(이름 없음)"}</span>
                    <span className="text-[10px] px-1.5 py-0.5 bg-gray-100 text-gray-600 rounded">{roleLabel}</span>
                    {!u.is_active && (
                      <span className="text-[10px] px-1.5 py-0.5 bg-red-50 text-red-500 rounded">비활성</span>
                    )}
                  </div>
                  <div className="text-xs text-gray-500">{u.email}</div>
                  {u.memo && <div className="text-[10px] text-gray-500 mt-0.5">메모: {u.memo}</div>}
                  <div className="text-[10px] text-gray-400 mt-0.5">
                    {u.last_login_at
                      ? `최근 로그인 ${new Date(u.last_login_at).toLocaleString("ko-KR")}`
                      : "로그인 기록 없음"}
                  </div>
                </div>
                <div className="text-right text-[10px] text-gray-400 whitespace-nowrap">
                  <div>{new Date(u.created_at).toLocaleString("ko-KR", { dateStyle: "short", timeStyle: "short" })}</div>
                  {creatorLabel && <div className="text-gray-500">by {creatorLabel}</div>}
                </div>
              </li>
              );
            })}
          </ul>
        )}
        <p className="mt-4 text-[11px] text-gray-400">
          직원/매니저 비활성화/추가는 사장님 대시보드 [구독 및 설정] 에서 진행됩니다.
        </p>
      </div>
      <div className="flex gap-2 p-5 border-t border-gray-100">
        <button onClick={onClose}
          className="flex-1 py-2.5 border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50 text-sm">
          닫기
        </button>
      </div>
    </Modal>
  );
}

function StatusBadge({ status }: { status: TenantStatus }) {
  const map: Record<TenantStatus, { label: string; cls: string }> = {
    pending:   { label: "승인 대기", cls: "bg-orange-100 text-orange-700" },
    active:    { label: "활성",      cls: "bg-green-100 text-green-700" },
    suspended: { label: "정지",      cls: "bg-red-100 text-red-600" },
  };
  const { label, cls } = map[status];
  return <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${cls}`}>{label}</span>;
}

// 비밀번호 강제 재설정 — admin 이 사장 비번을 직접 발급해주는 흐름.
// (이메일 self-reset 불필요 / CS 부담 최소화)
function PasswordResetSection({ email }: { email: string }) {
  const [open, setOpen] = useState(false);
  const [newPassword, setNewPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  async function handleReset() {
    if (newPassword.length < 6) {
      setMessage({ kind: "err", text: "비밀번호는 6자 이상이어야 합니다." });
      return;
    }
    if (!confirm(`${email} 비밀번호를 새로 설정하시겠습니까?\n새 비번을 사장에게 직접 전달하셔야 합니다.`)) return;

    setSubmitting(true);
    setMessage(null);
    const { data: { session } } = await supabase.auth.getSession();
    const res = await fetch("/api/admin/reset-password", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${session?.access_token}`,
      },
      body: JSON.stringify({ email, new_password: newPassword }),
    });
    const json = await res.json();
    setSubmitting(false);
    if (!res.ok) {
      setMessage({ kind: "err", text: json.error ?? "재설정 실패" });
      return;
    }
    setMessage({ kind: "ok", text: "비밀번호가 변경되었습니다. 사장에게 새 비번을 전달해주세요." });
    setNewPassword("");
  }

  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)}
        className="text-xs px-3 py-1.5 border border-gray-300 rounded-lg text-gray-600 hover:bg-gray-50">
        비밀번호 강제 재설정
      </button>
    );
  }

  return (
    <div className="p-3 bg-yellow-50 border border-yellow-200 rounded-lg space-y-2">
      <p className="text-xs font-semibold text-yellow-700">비밀번호 강제 재설정</p>
      <div className="flex gap-2">
        <input type="text" value={newPassword} onChange={e => setNewPassword(e.target.value)}
          placeholder="새 비밀번호 (6자 이상)"
          className="flex-1 input-md" />
        <button type="button" onClick={handleReset} disabled={submitting}
          className="px-3 py-2 bg-primary text-white text-sm rounded-lg hover:bg-primary-hover disabled:opacity-50">
          {submitting ? "변경 중..." : "변경"}
        </button>
        <button type="button" onClick={() => { setOpen(false); setMessage(null); setNewPassword(""); }}
          className="px-3 py-2 border border-gray-300 text-gray-600 text-sm rounded-lg hover:bg-gray-50">
          취소
        </button>
      </div>
      {message && (
        <p className={`text-xs ${message.kind === "ok" ? "text-green-600" : "text-red-500"}`}>{message.text}</p>
      )}
    </div>
  );
}
