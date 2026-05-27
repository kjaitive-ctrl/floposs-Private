"use client";

import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import { getOrCreateTenantId } from "@/lib/tenant";
import type { Customer } from "@/lib/types";
import ToggleSwitch from "./ToggleSwitch";
import Modal from "./Modal";

// 하위 호환 — 기존 import 처리해온 곳들이 깨지지 않도록 re-export.
export type { Customer };

const emptyForm = {
  company_name: "", business_name: "", business_number: "", tax_email: "",
  owner_name: "", phone: "", email: "", address: "",
  contact1_name: "", contact1_phone: "", contact1_role: "",
  contact2_name: "", contact2_phone: "", contact2_role: "",
  buyer_name: "", buyer_phone: "",
  region: "", business_form: "" as "" | "online" | "offline" | "etc",
  credit_limit: 0, include_vat: true, default_payment_method: "cash", memo: "",
};

type Props = {
  editing: Customer | null;
  onClose: () => void;
  // saved — 신규 등록(INSERT) 시 새 거래처 row. SaleForm 등 외부에서 즉시 선택 시 사용.
  // 기존 호출처(customers/page.tsx)는 인자 무시하고 fetchCustomers 호출.
  onSaved: (saved?: Customer) => void;
};

export default function CustomerModal({ editing, onClose, onSaved }: Props) {
  const [form, setForm] = useState(emptyForm);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (editing) {
      setForm({
        company_name: editing.company_name,
        business_name: editing.business_name || "",
        business_number: editing.business_number || "",
        tax_email: editing.tax_email || "",
        owner_name: editing.owner_name || "",
        phone: editing.phone || "",
        email: editing.email || "",
        address: editing.address || "",
        contact1_name: editing.contact1_name || "",
        contact1_phone: editing.contact1_phone || "",
        contact1_role: editing.contact1_role || "",
        contact2_name: editing.contact2_name || "",
        contact2_phone: editing.contact2_phone || "",
        contact2_role: editing.contact2_role || "",
        buyer_name: editing.buyer_name || "",
        buyer_phone: editing.buyer_phone || "",
        region: editing.region || "",
        business_form: editing.business_form ?? "",
        credit_limit: editing.credit_limit,
        include_vat: editing.include_vat,
        default_payment_method: editing.default_payment_method ?? "cash",
        memo: editing.memo || "",
      });
    } else {
      setForm(emptyForm);
    }
  }, [editing]);

  async function handleSave() {
    if (!form.company_name.trim()) return alert("업체명을 입력해주세요.");
    setSaving(true);
    const tenantId = await getOrCreateTenantId();
    if (!tenantId) { alert("사용자 정보를 찾을 수 없습니다."); setSaving(false); return; }

    // business_form CHECK 제약 — "" 빈 문자열은 null 로 변환 필요.
    // include_vat 은 payment_method 종속 — 청구만 true, 그 외 false (관리자 정책 2026-05-11).
    const payload = {
      ...form,
      region: form.region.trim() || null,
      business_form: form.business_form || null,
      include_vat: form.default_payment_method === "credit",
      tenant_id: tenantId,
    };

    // retail 연동 거래처 = retail 마스터 필드 변경 권한이 retail 측에만 (2026-05-15 정책).
    // UI 는 disabled 로 잠갔지만 dev tool 우회 방지 + 미래 신규 수정 path 안전망.
    // 마스터 필드: company_name, owner_name, phone, address, business_number, default_payment_method, include_vat
    if (editing?.linked_tenant_id) {
      payload.company_name = editing.company_name;
      payload.owner_name = editing.owner_name ?? "";
      payload.phone = editing.phone ?? "";
      payload.address = editing.address ?? "";
      payload.business_number = editing.business_number ?? "";
      payload.default_payment_method = editing.default_payment_method;
      payload.include_vat = editing.include_vat;
    }
    if (editing) {
      const { error } = await supabase.from("customers").update(payload).eq("id", editing.id);
      if (error) { alert(error.message); setSaving(false); return; }
      setSaving(false);
      onSaved();
    } else {
      const { data, error } = await supabase.from("customers").insert(payload).select().single();
      if (error) { alert(error.message); setSaving(false); return; }
      setSaving(false);
      onSaved(data as Customer);
    }
  }

  return (
    <Modal onClose={onClose} size="lg">
      <div className="p-6">
        <h3 className="text-lg font-bold text-gray-900 mb-4">
          {editing ? "거래처 수정" : "거래처 등록"}
        </h3>

        {/* retail 연동 거래처 안내 — 마스터 필드 read-only 정책 (2026-05-15) */}
        {editing?.linked_tenant_id && (
          <div className="mb-4 text-xs text-sky-800 bg-sky-50 border border-sky-200 rounded-lg px-3 py-2 leading-relaxed">
            <b>retail 연동 거래처</b> · 매장명/사업자번호/주소/결제수단 등 retail 정보는 <b>retail 측만 변경 가능</b>합니다.
            외상한도/메모/담당자/사입자/지역 등 거래 관리 정보는 자유롭게 수정하세요.
          </div>
        )}

        <div className="space-y-4">
          {/* 기본정보 */}
          <div>
            <p className="text-xs font-semibold text-gray-400 uppercase mb-2">기본 정보</p>
            <div className="space-y-2">
              {/* 업체명 + 형태 토글 — 같은 row. 이미지2 의도 반영. */}
              <div className="flex gap-2 items-end">
                <div className="flex-1">
                  <label className="block text-xs font-medium text-gray-600 mb-1">업체명 *</label>
                  <input type="text" value={form.company_name}
                    onChange={e => setForm({ ...form, company_name: e.target.value })}
                    disabled={!!editing?.linked_tenant_id}
                    className={`w-full input-md ${editing?.linked_tenant_id ? "bg-gray-50 text-gray-500 cursor-not-allowed" : ""}`} />
                </div>
                <div className="shrink-0">
                  <label className="block text-xs font-medium text-gray-600 mb-1">형태</label>
                  <div className="flex gap-1">
                    {([
                      ["online", "온라인"],
                      ["offline", "오프라인"],
                      ["etc", "기타"],
                    ] as const).map(([val, label]) => (
                      <button key={val} type="button"
                        onClick={() => setForm({ ...form, business_form: form.business_form === val ? "" : val })}
                        className={`px-3 py-2 text-xs font-medium rounded-lg border transition-colors ${
                          form.business_form === val
                            ? "bg-primary text-white border-primary"
                            : "bg-white text-gray-600 border-gray-300 hover:bg-gray-50"
                        }`}>
                        {label}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
              {/* retail 마스터(read-only when linked): business_number, address. wholesale 전용: region, business_name, tax_email. */}
              {([
                { label: "지역", key: "region", placeholder: "예: 서울 강남구", master: false },
                { label: "사업자 상호명", key: "business_name", placeholder: "", master: false },
                { label: "사업자등록번호", key: "business_number", placeholder: "", master: true },
                { label: "택배 발송 주소", key: "address", placeholder: "", master: true },
                { label: "세금계산서 이메일", key: "tax_email", placeholder: "", master: false },
              ] as { label: string; key: keyof typeof emptyForm; placeholder: string; master: boolean }[]).map(({ label, key, placeholder, master }) => {
                const locked = master && !!editing?.linked_tenant_id;
                return (
                  <div key={key}>
                    <label className="block text-xs font-medium text-gray-600 mb-1">{label}</label>
                    <input type="text" value={form[key] as string} placeholder={placeholder}
                      onChange={e => !locked && setForm({ ...form, [key]: e.target.value })}
                      disabled={locked}
                      className={`w-full input-md ${locked ? "bg-gray-50 text-gray-500 cursor-not-allowed" : ""}`} />
                  </div>
                );
              })}
            </div>
          </div>

          {/* 사입자 */}
          <div>
            <p className="text-xs font-semibold text-gray-400 uppercase mb-2">사입자</p>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">사입사명</label>
                <input type="text" placeholder="사입사 이름" value={form.buyer_name}
                  onChange={e => setForm({ ...form, buyer_name: e.target.value })}
                  className="w-full input-md" />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">사입자 전화번호</label>
                <input type="text" placeholder="010-0000-0000" value={form.buyer_phone}
                  onChange={e => setForm({ ...form, buyer_phone: e.target.value })}
                  className="w-full input-md" />
              </div>
            </div>
          </div>

          {/* 담당자 */}
          <div>
            <p className="text-xs font-semibold text-gray-400 uppercase mb-2">담당자</p>
            <div className="grid grid-cols-3 gap-2">
              {([
                { label: "역할", key: "contact1_role", placeholder: "주문담당" },
                { label: "이름", key: "contact1_name", placeholder: "홍길동" },
                { label: "연락처", key: "contact1_phone", placeholder: "010-0000-0000" },
                { label: "역할", key: "contact2_role", placeholder: "물류담당" },
                { label: "이름", key: "contact2_name", placeholder: "홍길동" },
                { label: "연락처", key: "contact2_phone", placeholder: "010-0000-0000" },
              ] as { label: string; key: keyof typeof emptyForm; placeholder: string }[]).map(({ label, key, placeholder }) => (
                <div key={key}>
                  <label className="block text-xs font-medium text-gray-600 mb-1">{label}</label>
                  <input type="text" placeholder={placeholder} value={form[key] as string}
                    onChange={e => setForm({ ...form, [key]: e.target.value })}
                    className="w-full input-md" />
                </div>
              ))}
            </div>
          </div>

          {/* 거래 설정 */}
          <div>
            <p className="text-xs font-semibold text-gray-400 uppercase mb-2">거래 설정</p>
            <div className="space-y-2">
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">외상한도 (원)</label>
                <input type="number" value={form.credit_limit}
                  onChange={e => setForm({ ...form, credit_limit: Number(e.target.value) })}
                  className="w-full input-md" />
              </div>
              <div>
                <div className="flex items-center justify-between mb-1">
                  <label className="block text-xs font-medium text-gray-600">결제방식 (기본값)</label>
                  {/* retail 연동 거래처 = 결제수단 변경 권한이 retail 측에만 (2026-05-15 정책). wholesale 사장은 read-only. */}
                  {editing?.linked_tenant_id && (
                    <span className="px-2 py-0.5 text-[10px] font-semibold rounded bg-sky-100 text-sky-700 border border-sky-200">
                      retail 연동 · 변경 불가
                    </span>
                  )}
                </div>
                <div className="flex gap-2">
                  {([["cash", "현금"], ["transfer", "통장"], ["credit", "청구"]] as const).map(([val, label]) => {
                    const linked = !!editing?.linked_tenant_id;
                    const selected = form.default_payment_method === val;
                    return (
                      <button
                        key={val}
                        type="button"
                        disabled={linked}
                        onClick={() => !linked && setForm({ ...form, default_payment_method: val })}
                        className={`flex-1 py-2 text-sm font-medium rounded-lg border transition-colors ${
                          selected
                            ? val === "cash"     ? "bg-cash text-white border-cash"
                            : val === "transfer" ? "bg-transfer text-white border-transfer"
                                                 : "bg-credit text-white border-credit"
                            : "bg-white text-gray-600 border-gray-300 hover:bg-gray-50"
                        } ${linked ? "opacity-60 cursor-not-allowed" : ""}`}
                      >
                        {label}
                      </button>
                    );
                  })}
                </div>
              </div>
              {/* 부가세 적용 — payment_method 종속 (수동 토글 X). 청구만 vat 포함. */}
              <div className="flex items-center justify-between py-2">
                <p className="text-sm text-gray-600">부가세 적용</p>
                <p className="text-sm font-medium text-gray-800">
                  {form.default_payment_method === "credit" ? "결제시 부가세 포함" : "결제시 부가세 제외"}
                </p>
              </div>
            </div>
          </div>

          {/* 메모 */}
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">메모</label>
            <textarea value={form.memo} onChange={e => setForm({ ...form, memo: e.target.value })}
              rows={2}
              className="w-full input-md" />
          </div>
        </div>

        <div className="flex gap-2 mt-5">
          <button onClick={onClose}
            className="flex-1 py-2 border border-gray-300 text-gray-700 text-sm rounded-lg hover:bg-gray-50">
            취소
          </button>
          <button onClick={handleSave} disabled={saving}
            className="flex-1 py-2 bg-primary text-white text-sm rounded-lg hover:bg-primary-hover disabled:opacity-50">
            {saving ? "저장 중..." : "저장"}
          </button>
        </div>
      </div>
    </Modal>
  );
}
