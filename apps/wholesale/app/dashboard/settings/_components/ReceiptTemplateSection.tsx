"use client";

import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabase";
import { getOrCreateTenantId } from "@/lib/tenant";
import { ReceiptPreview } from "../../_components/receipt/ReceiptPreview";
import {
  buildReceiptDoc, buildPendingDoc, buildSampleDoc,
} from "../../_components/receipt/template";
import type {
  FormOptions, ReceiptOverrides, BusinessInfo,
  ReceiptData, PendingData, SampleData,
} from "../../_components/receipt/types";
import ToggleSwitch from "../../_components/ToggleSwitch";
import Button from "../../_components/Button";

type FormKey = "receipt" | "pending" | "sample";

const FORM_LABELS: Record<FormKey, string> = {
  receipt: "영수증",
  pending: "발송/미발송내역",
  sample:  "샘플 전표",
};

const FORM_DESCRIPTIONS: Record<FormKey, { summary: string; usages: string[] }> = {
  receipt: {
    summary: "모든 출고 / 판매 확정 시 발행. 1주문 = 1영수증.",
    usages: [
      "당일 출고 처리",
      "미송 주문 출고 처리 (= derived 주문 발행)",
      "오더(보류) 주문 출고 처리",
      "샘플 결제 (샘플 → 매출 전환)",
      "반품 / 교환 (음수 영수증 + 신규 영수증)",
      "미송·보류 해제 (음수 매출 인식)",
    ],
  },
  pending: {
    summary: "현재 보유 중인 미발송(미송/오더) 명세 출력. 매출 인식 X.",
    usages: [
      "거래처 단위 미발송 합쳐서 출력 (\"우리 지금 미송 몇 장 있어요?\")",
      "상품 단위 미발송 합쳐서 출력",
      "당일 등록 미발송 한 번에 출력",
      "오더(보류) = 미송과 동일 카테고리로 합쳐 출력",
    ],
  },
  sample: {
    summary: "샘플 출고 시 발행. 회수/반환은 시스템에서 처리, 별도 양식 없음.",
    usages: [
      "샘플 출고 시 (거래처에 샘플과 함께 전달)",
    ],
  },
};

const DEFAULTS: Record<FormKey, FormOptions> = {
  receipt: { showBank1: true, showVatNote: true, vatNoteText: "상기금액은 부가세별도 금액입니다." },
  pending: { showBank1: true, showVatNote: true, vatNoteText: "상기금액은 부가세별도 금액입니다." },
  sample:  { showBank1: true, showVatNote: true, vatNoteText: "상기금액은 부가세별도 금액입니다.",
             showOptions: true, showMaterial: true },
};

// 미리보기용 샘플 데이터
const DEMO_ITEMS = [
  { name: "단가라반팔티", qty: 1, unitPrice: 5000, amount: 5000, option: "검정 F" },
  { name: "원피스",      qty: 2, unitPrice: 8000, amount: 16000, option: "소라 M", isBackorder: true },
];
const DEMO_EXTRAS = [
  { productName: "단가라반팔티", colors: ["검정", "흰색"], sizes: ["F"],     material: "면100" },
  { productName: "원피스",      colors: ["소라"],         sizes: ["M", "L"], material: "면80 폴리20" },
];

export default function ReceiptTemplateSection() {
  const [tenantId, setTenantId] = useState<string | null>(null);
  const [biz, setBiz] = useState<BusinessInfo | null>(null);
  const [overrides, setOverrides] = useState<ReceiptOverrides>({});
  const [activeForm, setActiveForm] = useState<FormKey>("receipt");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    (async () => {
      const id = await getOrCreateTenantId();
      setTenantId(id);
      if (!id) { setLoading(false); return; }
      const { data: tenant } = await supabase
        .from("tenants")
        .select(`company_name, business_number, owner_name, phone, address, biz_address,
                 business_type, business_category,
                 main_bank_name, main_bank_account, main_bank_holder,
                 sub_bank_name, sub_bank_account, sub_bank_holder,
                 receipt_text_overrides`)
        .eq("id", id).single();
      if (tenant) {
        setBiz({
          businessName:     tenant.company_name ?? "",
          businessNumber:   tenant.business_number ?? null,
          ceoName:          tenant.owner_name ?? null,
          phone:            tenant.phone ?? null,
          address:          tenant.biz_address ?? tenant.address ?? null,
          businessType:     tenant.business_type ?? null,
          businessCategory: tenant.business_category ?? null,
          bankInfo:  tenant.main_bank_name && tenant.main_bank_account ? {
            name: tenant.main_bank_name, account: tenant.main_bank_account, holder: tenant.main_bank_holder ?? "",
          } : null,
          bankInfo2: tenant.sub_bank_name && tenant.sub_bank_account ? {
            name: tenant.sub_bank_name, account: tenant.sub_bank_account, holder: tenant.sub_bank_holder ?? "",
          } : null,
        });
        setOverrides((tenant.receipt_text_overrides as ReceiptOverrides | null) ?? {});
      }
      setLoading(false);
    })();
  }, []);

  const current = overrides[activeForm] ?? {};

  function update(key: keyof FormOptions, value: string | boolean) {
    setOverrides(prev => ({
      ...prev,
      [activeForm]: { ...(prev[activeForm] ?? {}), [key]: value },
    }));
    setSaved(false);
  }

  function resetForm() {
    if (!confirm(`${FORM_LABELS[activeForm]} 양식을 기본값으로 되돌릴까요?`)) return;
    setOverrides(prev => {
      const next = { ...prev };
      delete next[activeForm];
      return next;
    });
    setSaved(false);
  }

  async function save() {
    if (!tenantId) return;
    setSaving(true);
    setSaved(false);
    const { error } = await supabase
      .from("tenants")
      .update({ receipt_text_overrides: overrides })
      .eq("id", tenantId);
    setSaving(false);
    if (!error) { setSaved(true); setTimeout(() => setSaved(false), 3000); }
    else alert(error.message);
  }

  // ── 미리보기 도큐먼트 ────────────────────────────────────────
  const previewDoc = useMemo(() => {
    if (!biz) return null;
    const opts: FormOptions = { ...DEFAULTS[activeForm], ...current };
    if (activeForm === "receipt") {
      const data: ReceiptData = {
        ...biz,
        orderNumber:      "0001",
        orderDate:        "2026-05-04 12:57",
        shipDate:         "26-05-04(월)",
        customerName:     "예시거래처",
        paymentMethod:    "청구",
        paymentMethodKey: "credit",
        items:            DEMO_ITEMS,
        productExtras:    DEMO_EXTRAS,
        supply:           21000,
        vat:              2100,
        total:            23100,
        outstanding:      0,
        memo:             null,
        sessionSeq:       1,
        isReprint:        false,
        balanceSnapshot: {
          prevBalance: 50000, dayTotal: 23100,
          paymentMethod: "credit", paymentAmount: 23100, postBalance: 73100,
        },
        options: opts,
      };
      return buildReceiptDoc(data);
    }
    if (activeForm === "pending") {
      const data: PendingData = {
        ...biz,
        title:           "미발송내역",
        stampLabel:      "미송",
        customerName:    "예시거래처",
        documentNo:      null,
        documentDate:    "2026-05-04 12:57",
        items:           DEMO_ITEMS.map(i => ({ ...i, registeredDate: "2026-05-01" })),
        productExtras:   DEMO_EXTRAS,
        totalCount:      DEMO_ITEMS.length,
        totalQty:        DEMO_ITEMS.reduce((s, i) => s + i.qty, 0),
        totalAmount:     DEMO_ITEMS.reduce((s, i) => s + i.amount, 0),
        options: opts,
      };
      return buildPendingDoc(data);
    }
    // sample
    const data: SampleData = {
      ...biz,
      title:           "샘플 전표",
      stampLabel:      "샘플",
      customerName:    "예시거래처",
      documentNo:      null,
      documentDate:    "2026-05-04 12:57",
      shipDate:        "26-05-04(월)",
      items:           DEMO_ITEMS,
      productExtras:   DEMO_EXTRAS,
      totalCount:      DEMO_ITEMS.length,
      totalQty:        DEMO_ITEMS.reduce((s, i) => s + i.qty, 0),
      totalAmount:     DEMO_ITEMS.reduce((s, i) => s + i.amount, 0),
      options: opts,
    };
    return buildSampleDoc(data);
  }, [biz, activeForm, current]);

  if (loading) return <p className="text-gray-400 text-sm">불러오는 중...</p>;
  if (!biz)    return <p className="text-gray-400 text-sm">사업자 정보 누락</p>;

  return (
    <div className="grid grid-cols-2 gap-6">
      {/* ── 좌측: 편집 ─────────────────────────────────────────── */}
      <div className="space-y-5">
        {/* 양식 선택 */}
        <div className="flex gap-1 border border-gray-300 rounded-lg p-1 bg-gray-50">
          {(["receipt", "pending", "sample"] as const).map(k => (
            <button key={k} onClick={() => setActiveForm(k)}
              className={`flex-1 px-3 py-2 text-sm font-medium rounded-md transition-colors ${
                activeForm === k ? "bg-primary text-white" : "text-gray-600 hover:bg-gray-100"
              }`}>
              {FORM_LABELS[k]}
            </button>
          ))}
        </div>

        {/* 정의 및 용도 */}
        <section className="bg-primary-soft/40 border border-primary-border/40 rounded-xl p-5">
          <h3 className="text-sm font-semibold text-gray-800 mb-1.5">{FORM_LABELS[activeForm]} — 정의 및 용도</h3>
          <p className="text-sm text-gray-700 mb-3">{FORM_DESCRIPTIONS[activeForm].summary}</p>
          <ul className="space-y-1">
            {FORM_DESCRIPTIONS[activeForm].usages.map((u, i) => (
              <li key={i} className="flex items-start gap-1.5 text-xs text-gray-600">
                <span className="text-primary-ring shrink-0">•</span>
                <span>{u}</span>
              </li>
            ))}
          </ul>
        </section>

        {/* 푸터1 — 자유 문단 (구분선 위) */}
        <section className="bg-white rounded-xl border border-gray-200 p-5">
          <h3 className="text-sm font-semibold text-gray-700 mb-2">푸터1 — 자유 문단</h3>
          <p className="text-xs text-gray-400 mb-3">본문(잔액박스) 아래, 입금처 위에 표시. 빈값이면 표시 X.</p>
          <textarea value={current.customTop ?? ""}
            onChange={e => update("customTop", e.target.value)}
            rows={3}
            placeholder="예) 영업시간 09~18시. 휴무일은 매주 일요일입니다."
            className="w-full input-md resize-none" />
        </section>

        {/* 푸터2 — 상품 정보 */}
        <section className="bg-white rounded-xl border border-gray-200 p-5">
          <h3 className="text-sm font-semibold text-gray-700 mb-3">푸터2 — 상품 정보</h3>
          <div className="space-y-3">
            <ToggleRow label="상품 옵션 (색상/사이즈) 표시"
              hint="주문에 포함된 상품들의 옵션 셋 — 샘플 양식에 자주 사용"
              value={current.showOptions ?? DEFAULTS[activeForm].showOptions ?? false}
              onChange={v => update("showOptions", v)} />
            <ToggleRow label="혼용율 표시"
              hint="상품 등록 시 입력한 혼용율 (예: 면100 / 면80 폴리20)"
              value={current.showMaterial ?? DEFAULTS[activeForm].showMaterial ?? false}
              onChange={v => update("showMaterial", v)} />
          </div>
        </section>

        {/* 푸터3 — 영수증 하단 */}
        <section className="bg-white rounded-xl border border-gray-200 p-5">
          <h3 className="text-sm font-semibold text-gray-700 mb-3">푸터3 — 영수증 하단</h3>
          <div className="space-y-3">
            <ToggleRow label="메인 계좌 표시"
              hint={biz.bankInfo ? `${biz.bankInfo.name} ${biz.bankInfo.account} (${biz.bankInfo.holder})` : "메인 계좌 미입력 — 내 정보 탭에서 입력"}
              value={current.showBank1 ?? true}
              onChange={v => update("showBank1", v)} />
            <ToggleRow label="서브 계좌 표시"
              hint={biz.bankInfo2 ? `${biz.bankInfo2.name} ${biz.bankInfo2.account} (${biz.bankInfo2.holder})` : "서브 계좌 미입력 — 내 정보 탭에서 입력"}
              value={current.showBank2 ?? false}
              onChange={v => update("showBank2", v)} />
            <ToggleRow label="부가세 안내 표시"
              hint="*상기금액은 부가세별도 금액입니다 같은 안내문"
              value={current.showVatNote ?? true}
              onChange={v => update("showVatNote", v)} />
            {(current.showVatNote ?? true) && (
              <div className="ml-2 pl-3 border-l-2 border-gray-200">
                <label className="block text-xs font-medium text-gray-500 mb-1">부가세 안내 텍스트</label>
                <input type="text" value={current.vatNoteText ?? ""}
                  onChange={e => update("vatNoteText", e.target.value)}
                  placeholder="상기금액은 부가세별도 금액입니다."
                  className="w-full input-md" />
              </div>
            )}
            <div>
              <label className="block text-sm text-gray-700 mb-1">추가 멘트</label>
              <textarea value={current.customBottom ?? ""}
                onChange={e => update("customBottom", e.target.value)}
                rows={2}
                placeholder="예) 환불/교환은 영수증 지참 후 7일 이내."
                className="w-full input-md resize-none" />
            </div>
          </div>
        </section>

        {/* 기타 */}
        <section className="bg-white rounded-xl border border-gray-200 p-5">
          <h3 className="text-sm font-semibold text-gray-700 mb-3">기타</h3>
          <ToggleRow label="영수증번호 바코드"
            hint="영수증 하단에 주문번호 바코드 출력 (스캐너 사용 시). 미래 대비 — 보통 OFF."
            value={current.showBarcode ?? false}
            onChange={v => update("showBarcode", v)} />
        </section>

        {/* 저장/초기화 */}
        <div className="flex items-center gap-3">
          <Button onClick={save} disabled={saving}>{saving ? "저장 중..." : "저장"}</Button>
          <Button variant="secondary" onClick={resetForm}>{FORM_LABELS[activeForm]} 기본값으로</Button>
          {saved && <span className="text-sm text-green-600">저장되었습니다.</span>}
        </div>
      </div>

      {/* ── 우측: 미리보기 (viewport 기준 100% 높이) ───────────── */}
      <div className="sticky top-4 self-start" style={{ height: "calc(100vh - 6rem)" }}>
        <p className="text-xs text-gray-500 mb-2">미리보기 — {FORM_LABELS[activeForm]} 양식 (샘플 데이터)</p>
        <div className="bg-gray-50 rounded-lg p-4 overflow-y-auto" style={{ height: "calc(100% - 1.75rem)" }}>
          {previewDoc && <ReceiptPreview doc={previewDoc} />}
        </div>
      </div>
    </div>
  );
}

// ── ToggleRow 헬퍼 ──────────────────────────────────────────────
function ToggleRow({ label, hint, value, onChange }: {
  label: string; hint?: string; value: boolean; onChange: (v: boolean) => void;
}) {
  return (
    <div className="flex items-start justify-between gap-4 py-1">
      <div>
        <p className="text-sm text-gray-700">{label}</p>
        {hint && <p className="text-xs text-gray-400 mt-0.5">{hint}</p>}
      </div>
      <ToggleSwitch value={value} onChange={onChange} />
    </div>
  );
}
