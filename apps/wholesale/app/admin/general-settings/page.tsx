"use client";

import { useEffect, useState, useCallback } from "react";
import { supabase } from "@/lib/supabase";

type SettingsForm = {
  company_name: string;
  representative_name: string;
  business_number: string;
  ecommerce_license: string;
  address: string;
  contact_email: string;
  service_name: string;
  service_brand_letter: string;
  privacy_officer_name: string;
  privacy_officer_email: string;
  privacy_officer_phone: string;
};

const emptyForm: SettingsForm = {
  company_name: "",
  representative_name: "",
  business_number: "",
  ecommerce_license: "",
  address: "",
  contact_email: "",
  service_name: "",
  service_brand_letter: "",
  privacy_officer_name: "",
  privacy_officer_email: "",
  privacy_officer_phone: "",
};

export default function GeneralSettingsPage() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<Date | null>(null);
  const [form, setForm] = useState<SettingsForm>(emptyForm);

  const fetchSettings = useCallback(async () => {
    setLoading(true);
    const { data } = await supabase
      .from("platform_settings")
      .select("*")
      .eq("id", 1)
      .maybeSingle();
    if (data) {
      setForm({
        company_name: data.company_name ?? "",
        representative_name: data.representative_name ?? "",
        business_number: data.business_number ?? "",
        ecommerce_license: data.ecommerce_license ?? "",
        address: data.address ?? "",
        contact_email: data.contact_email ?? "",
        service_name: data.service_name ?? "",
        service_brand_letter: data.service_brand_letter ?? "",
        privacy_officer_name: data.privacy_officer_name ?? "",
        privacy_officer_email: data.privacy_officer_email ?? "",
        privacy_officer_phone: data.privacy_officer_phone ?? "",
      });
    }
    setLoading(false);
  }, []);

  useEffect(() => { fetchSettings(); }, [fetchSettings]);

  async function handleSave() {
    setSaving(true);
    const payload = {
      company_name: form.company_name.trim() || null,
      representative_name: form.representative_name.trim() || null,
      business_number: form.business_number.trim() || null,
      ecommerce_license: form.ecommerce_license.trim() || null,
      address: form.address.trim() || null,
      contact_email: form.contact_email.trim() || null,
      service_name: form.service_name.trim() || null,
      service_brand_letter: form.service_brand_letter.trim() || null,
      privacy_officer_name: form.privacy_officer_name.trim() || null,
      privacy_officer_email: form.privacy_officer_email.trim() || null,
      privacy_officer_phone: form.privacy_officer_phone.trim() || null,
    };
    // 싱글톤 — id=1 row 가 시드로 항상 존재. UPSERT 로 안전하게 처리.
    const { error } = await supabase
      .from("platform_settings")
      .upsert({ id: 1, ...payload });
    setSaving(false);
    if (error) {
      alert("저장 실패: " + error.message);
      return;
    }
    setSavedAt(new Date());
  }

  function update<K extends keyof SettingsForm>(key: K, value: SettingsForm[K]) {
    setForm(f => ({ ...f, [key]: value }));
  }

  if (loading) {
    return <p className="text-gray-400 text-sm">불러오는 중...</p>;
  }

  return (
    <div className="max-w-2xl">
      <div className="mb-6">
        <h2 className="text-2xl font-bold text-gray-900">일반설정</h2>
        <p className="text-sm text-gray-500 mt-0.5">
          로그인 페이지 footer 등 사이트 전역에 노출되는 사업자 정보를 관리합니다.
        </p>
      </div>

      <div className="bg-white rounded-xl border border-gray-200 p-6 space-y-6">
        {/* 서비스 브랜딩 */}
        <Section title="서비스 정보">
          <div className="grid grid-cols-2 gap-3">
            <Field label="서비스명">
              <Input value={form.service_name} onChange={v => update("service_name", v)}
                placeholder="플로포스" />
            </Field>
            <Field label="로고 letter (1글자)">
              <Input value={form.service_brand_letter} onChange={v => update("service_brand_letter", v.slice(0, 2))}
                placeholder="F" />
            </Field>
          </div>
        </Section>

        {/* 사업자 정보 */}
        <Section title="사업자 정보">
          <Field label="회사명">
            <Input value={form.company_name} onChange={v => update("company_name", v)}
              placeholder="(주)케이제이리테일" />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="대표자명">
              <Input value={form.representative_name} onChange={v => update("representative_name", v)}
                placeholder="장성민" />
            </Field>
            <Field label="사업자등록번호">
              <Input value={form.business_number} onChange={v => update("business_number", v)}
                placeholder="000-00-00000" />
            </Field>
          </div>
          <Field label="통신판매업신고번호">
            <Input value={form.ecommerce_license} onChange={v => update("ecommerce_license", v)}
              placeholder="제2024-서울중구-0000호" />
          </Field>
          <Field label="주소">
            <Input value={form.address} onChange={v => update("address", v)}
              placeholder="우편번호 + 도로명주소 + 상세주소" />
          </Field>
          <Field label="연락처 이메일">
            <Input value={form.contact_email} onChange={v => update("contact_email", v)}
              placeholder="cs@example.com" type="email" />
          </Field>
        </Section>

        {/* 개인정보보호책임자 */}
        <Section title="개인정보보호 책임자 (개인정보처리방침에 표시)">
          <div className="grid grid-cols-2 gap-3">
            <Field label="책임자명">
              <Input value={form.privacy_officer_name} onChange={v => update("privacy_officer_name", v)}
                placeholder="홍길동" />
            </Field>
            <Field label="책임자 연락처">
              <Input value={form.privacy_officer_phone} onChange={v => update("privacy_officer_phone", v)}
                placeholder="010-0000-0000" />
            </Field>
          </div>
          <Field label="책임자 이메일">
            <Input value={form.privacy_officer_email} onChange={v => update("privacy_officer_email", v)}
              placeholder="privacy@example.com" type="email" />
          </Field>
        </Section>
      </div>

      <div className="flex items-center gap-3 mt-5">
        <button onClick={handleSave} disabled={saving}
          className="px-5 py-2.5 bg-primary text-white text-sm rounded-lg hover:bg-primary-hover disabled:opacity-60 font-medium">
          {saving ? "저장 중..." : "저장"}
        </button>
        {savedAt && (
          <span className="text-xs text-gray-500">
            저장됨 · {savedAt.toLocaleTimeString()}
          </span>
        )}
      </div>
    </div>
  );
}

// ──────────────────────────────────────────────────
// 소형 헬퍼
// ──────────────────────────────────────────────────
function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-3">{title}</div>
      <div className="space-y-3">{children}</div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-xs text-gray-600 mb-1">{label}</label>
      {children}
    </div>
  );
}

function Input({
  value, onChange, placeholder, type = "text",
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  type?: string;
}) {
  return (
    <input type={type} value={value} onChange={e => onChange(e.target.value)}
      placeholder={placeholder}
      className="w-full input-md" />
  );
}
