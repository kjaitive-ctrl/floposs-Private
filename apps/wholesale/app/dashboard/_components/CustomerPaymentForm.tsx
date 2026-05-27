"use client";

import { useState } from "react";

// 거래처 입금/환불 처리 공통 폼
// - 금액 단일 칸 (양수만)
// - 부가세 체크박스 (거래처 기본값에서 시작 — 사용자가 건별 토글 가능)
// - 자동 분리 미리보기: 공급가 + 부가세 = 전체
// - 하단 [환불 처리] / [입금 처리] 두 버튼 — 부호는 어느 버튼 누르냐로 결정
//
// 부모는 onSubmit 에서 RPC 호출 + 후처리. processing 상태는 부모가 관리.
// onSubmit 의 amount 부호: 입금=양수, 환불=음수.

type SubmitData = {
  amount: number;       // 입금=+absAmt, 환불=-absAmt
  vatOn: boolean;       // 부가세 적용 여부
  vatAmount: number;    // absAmt * 1/11 (vatOn=true 시), else 0 — 항상 양수
  supplyAmount: number; // absAmt - vatAmount — 항상 양수
};

type Props = {
  customerName: string;
  customerVatDefault: boolean;
  paymentMethodLabel?: string;       // "현금" / "통장" / "청구"
  paymentMethodColorClass?: string;  // tailwind text-* class
  processing: boolean;
  onCancel: () => void;
  onSubmit: (data: SubmitData) => Promise<void> | void;
};

export default function CustomerPaymentForm({
  customerName,
  customerVatDefault,
  paymentMethodLabel,
  paymentMethodColorClass,
  processing,
  onCancel,
  onSubmit,
}: Props) {
  const [amountStr, setAmountStr] = useState("");
  // vatOn — 거래처 include_vat 종속 (관리자 정책 2026-05-11). 수동 토글 X.
  const vatOn = customerVatDefault;

  const absAmt    = Math.round(parseFloat(amountStr.replace(/,/g, "")) || 0);
  const vatPart   = vatOn ? Math.round(absAmt / 11) : 0;
  const supplyPart = absAmt - vatPart;

  function handleSubmit(action: "deposit" | "refund") {
    if (processing || !absAmt) return;
    const sign = action === "refund" ? -1 : 1;
    onSubmit({
      amount:       sign * absAmt,
      vatOn,
      vatAmount:    vatPart,
      supplyAmount: supplyPart,
    });
  }

  return (
    <div className="shrink-0 mt-3 border border-gray-200 rounded-xl overflow-hidden">
      <div className="px-4 py-2 bg-gray-100 border-b border-gray-200">
        <span className="text-xs font-semibold text-gray-600 tracking-wide">입출금 처리</span>
      </div>
      <div className="px-4 py-4 bg-white flex flex-col gap-3">

        {/* 거래처 + 결제수단 + 거래처 기본 부가세 */}
        <div className="flex items-center gap-3">
          <label className="w-20 text-sm text-gray-500 shrink-0">거래처</label>
          <span className="text-sm font-semibold text-gray-900">{customerName}</span>
          {paymentMethodLabel && (
            <span className={`text-xs font-medium ${paymentMethodColorClass ?? "text-gray-500"}`}>
              {paymentMethodLabel}
            </span>
          )}
          <span className={`text-xs px-1.5 py-0.5 rounded border ${
            customerVatDefault
              ? "text-orange-600 border-orange-200 bg-orange-50"
              : "text-gray-400 border-gray-200 bg-gray-50"
          }`}>
            거래처 기본 부가세 {customerVatDefault ? "ON" : "OFF"}
          </span>
        </div>

        {/* 금액 + 건별 부가세 토글 — 양수만 */}
        <div className="flex items-center gap-3">
          <label className="w-20 text-sm text-gray-500 shrink-0">금액</label>
          <input
            type="text"
            value={amountStr}
            onChange={e => {
              const raw = e.target.value.replace(/[^0-9]/g, "");
              const num = parseInt(raw, 10);
              setAmountStr(isNaN(num) ? "" : num.toLocaleString());
            }}
            placeholder="통장에 찍힌 금액"
            className="flex-1 px-3 py-2 border border-gray-300 rounded-lg text-sm text-right focus:outline-none focus:ring-2 focus:ring-purple-400 placeholder:text-gray-300"
          />
          {/* 부가세 여부 — 거래처 include_vat 종속 (관리자 정책 2026-05-11). 수동 토글 X. */}
          <span className={`text-xs font-medium shrink-0 ${vatOn ? "text-orange-600" : "text-gray-400"}`}>
            {vatOn ? "부가세 포함" : "부가세 제외"}
          </span>
        </div>

        {/* 자동 분리 미리보기 */}
        <div className="flex items-center gap-3 px-3 py-2 bg-gray-50 rounded-lg text-xs">
          <span className="text-gray-400 w-20 shrink-0">분리</span>
          {absAmt === 0 ? (
            <span className="text-gray-300">금액 입력 시 공급가/부가세 자동 표시</span>
          ) : vatOn ? (
            <>
              <span className="text-gray-700">공급가 <b>{supplyPart.toLocaleString()}</b></span>
              <span className="text-gray-300">+</span>
              <span className="text-orange-600">부가세 <b>{vatPart.toLocaleString()}</b></span>
              <span className="text-gray-300">=</span>
              <span className="text-gray-700 font-medium">{absAmt.toLocaleString()}</span>
            </>
          ) : (
            <span className="text-gray-700">공급가 <b>{absAmt.toLocaleString()}</b> · 부가세 0</span>
          )}
        </div>

        {/* 하단 — 취소 + [환불 처리] [입금 처리] */}
        <div className="flex justify-end gap-2 pt-1">
          <button
            onClick={onCancel}
            disabled={processing}
            className="px-5 py-2 text-sm text-gray-600 border border-gray-300 rounded-lg hover:bg-gray-50 disabled:opacity-40"
          >취소</button>
          <button
            onClick={() => handleSubmit("refund")}
            disabled={processing || !amountStr}
            className="px-5 py-2 text-sm font-semibold text-white rounded-lg disabled:opacity-40 disabled:cursor-not-allowed bg-danger hover:bg-danger-hover"
          >
            {processing ? "처리 중..." : "환불 처리"}
          </button>
          <button
            onClick={() => handleSubmit("deposit")}
            disabled={processing || !amountStr}
            className="px-5 py-2 text-sm font-semibold text-white rounded-lg disabled:opacity-40 disabled:cursor-not-allowed bg-credit hover:bg-credit-hover"
          >
            {processing ? "처리 중..." : "입금 처리"}
          </button>
        </div>
      </div>
    </div>
  );
}
