// 영수증/미발송/샘플 양식 builders.
//
// 양식 = 3종:
//   - buildReceiptDoc : 영수증 (모든 출고 단일 양식. mode='normal' 일반/미송/보류 출고, mode='return' 반품)
//   - buildPendingDoc : 미발송 명세서 (잔액 박스 X, "미송"/"보류" 도장)
//   - buildSampleDoc  : 샘플 전표 (잔액 박스 X, "샘플" 도장, 옵션/혼용율 default ON)
//
// 양식 자체(레이아웃)는 코드 박제. 텍스트/토글만 tenant 단위 override (FormOptions).
// 푸터 = customTop / showOptions / showMaterial / showBank1+2 / showVatNote+text / customBottom / showBarcode.

import type {
  ReceiptDoc, ReceiptLine, ReceiptData, PendingData, SampleData,
  FormOptions, ProductExtra, BankInfo,
} from "./types";

const krw = (n: number) => n.toLocaleString("ko-KR");
const PAPER_WIDTH = 80 as const;
const CHARS_PER_LINE = 42;

// ── 양식별 default FormOptions (override 없으면 이걸 사용) ─────────
const DEFAULTS_RECEIPT: FormOptions = {
  customTop: "",
  showOptions: false, showMaterial: false,
  showBank1: true, showBank2: false,
  showVatNote: true, vatNoteText: "상기금액은 부가세별도 금액입니다.",
  customBottom: "",
  showBarcode: false,
};
const DEFAULTS_PENDING: FormOptions = { ...DEFAULTS_RECEIPT };
const DEFAULTS_SAMPLE:  FormOptions = { ...DEFAULTS_RECEIPT, showOptions: true, showMaterial: true };

function mergeOpts(base: FormOptions, override?: FormOptions): FormOptions {
  return { ...base, ...(override ?? {}) };
}

// ── 사업자정보 헤더 (사장 명세: 상호/전화번호/주소/업태:종목) ──────
function pushBusinessHeader(
  lines: ReceiptLine[],
  biz: { businessName: string; phone: string | null; address: string | null;
         businessType?: string | null; businessCategory?: string | null }
) {
  // 상호 (큰 글씨 강조)
  lines.push({ kind: "text", text: biz.businessName, align: "center", bold: true, size: 2 });
  lines.push({ kind: "blank" });
  // 라벨 행
  lines.push({ kind: "text", text: `상호: ${biz.businessName}`, align: "left" });
  if (biz.phone)   lines.push({ kind: "text", text: `전화번호: ${biz.phone}`, align: "left" });
  if (biz.address) lines.push({ kind: "text", text: `주소: ${biz.address}`, align: "left" });
  if (biz.businessType || biz.businessCategory) {
    const t = biz.businessType ?? "";
    const c = biz.businessCategory ?? "";
    lines.push({ kind: "text", text: `업태: ${t}    종목: ${c}`, align: "left" });
  }
}

// ── 푸터: 자유1 → 옵션/혼용율 → 입금처/부가세/자유2 → 바코드 ───────
function pushFooter(
  lines: ReceiptLine[],
  opts: FormOptions,
  data: { bankInfo?: BankInfo | null; bankInfo2?: BankInfo | null;
          productExtras?: ProductExtra[]; orderNumber?: string }
) {
  // 푸터1 — 자유 문단 (구분선 위)
  if (opts.customTop && opts.customTop.trim()) {
    lines.push({ kind: "blank" });
    for (const line of opts.customTop.split("\n")) {
      lines.push({ kind: "text", text: line, align: "left" });
    }
    lines.push({ kind: "rule", char: "=" });
  }

  // 푸터2 — 옵션 / 혼용율 (productExtras 있을 때만)
  const pes = data.productExtras ?? [];
  if (opts.showOptions && pes.length > 0) {
    lines.push({ kind: "blank" });
    lines.push({ kind: "text", text: "[옵션]", align: "left", bold: true });
    for (const pe of pes) {
      lines.push({ kind: "text", text: pe.productName, align: "left" });
      if (pe.colors.length > 0) lines.push({ kind: "text", text: `색상-${pe.colors.join(",")}`, align: "left" });
      if (pe.sizes.length  > 0) lines.push({ kind: "text", text: `사이즈-${pe.sizes.join(",")}`, align: "left" });
    }
  }
  if (opts.showMaterial && pes.length > 0) {
    lines.push({ kind: "blank" });
    lines.push({ kind: "text", text: "[혼용율]", align: "left", bold: true });
    for (const pe of pes) {
      if (pe.material) lines.push({ kind: "text", text: `${pe.productName} - ${pe.material}`, align: "left" });
    }
  }

  // 푸터3 — 입금처 + 부가세 안내 + 자유2
  lines.push({ kind: "blank" });
  if (opts.showBank1 && data.bankInfo && data.bankInfo.account) {
    const holder = data.bankInfo.holder ? ` (${data.bankInfo.holder})` : "";
    lines.push({ kind: "text", text: `*입금처: ${data.bankInfo.name} ${data.bankInfo.account}${holder}`, align: "left" });
  }
  if (opts.showBank2 && data.bankInfo2 && data.bankInfo2.account) {
    const holder = data.bankInfo2.holder ? ` (${data.bankInfo2.holder})` : "";
    lines.push({ kind: "text", text: `*입금처: ${data.bankInfo2.name} ${data.bankInfo2.account}${holder}`, align: "left" });
  }
  if (opts.showVatNote) {
    const note = opts.vatNoteText || "상기금액은 부가세별도 금액입니다.";
    lines.push({ kind: "text", text: `*${note}`, align: "left" });
  }
  if (opts.customBottom && opts.customBottom.trim()) {
    for (const line of opts.customBottom.split("\n")) {
      lines.push({ kind: "text", text: line, align: "left" });
    }
  }

  // 바코드 (주문번호) — default OFF
  if (opts.showBarcode && data.orderNumber) {
    lines.push({ kind: "blank" });
    lines.push({ kind: "barcode", value: data.orderNumber, hri: true });
  }

  // 마무리
  lines.push({ kind: "blank" });
  lines.push({ kind: "blank" });
  lines.push({ kind: "cut" });
}

// ── 영수증번호 표시 (영업세션 내 4자리 + 재발행) ───────────────────
function receiptNoLabel(sessionSeq: number | null | undefined, fallback: string | null | undefined, isReprint: boolean): string {
  const seq = sessionSeq != null ? String(sessionSeq).padStart(4, "0")
            : fallback ? fallback.slice(-4)
            : "";
  if (!seq) return "";
  return isReprint ? `${seq}-재발행` : seq;
}

// ────────────────────────────────────────────────────────────────────
// 1) 영수증 (사장 명세)
// ────────────────────────────────────────────────────────────────────
export function buildReceiptDoc(data: ReceiptData): ReceiptDoc {
  const lines: ReceiptLine[] = [];
  const opts = mergeOpts(DEFAULTS_RECEIPT, data.options);

  // 모드별 도장 + 본문 헤더 결정 (사장 정책 2026-05-06 단순화):
  //   - 'return' 만 별도 (도장 "반품"). 그 외 모든 출고 = 일반 영수증.
  //   - 미송 라인 ※ 표시는 items.isBackorder 자동, 잔량 박스는 unshippedFromOriginal 자동.
  const mode = data.mode ?? "normal";
  const stampLabel = mode === "return"    ? "반품"
                   : data.paymentMethodKey === "credit" ? "청구"
                   : "영수";
  const subtotalHeader = mode === "return" ? "--- 반품내역 ---"
                       : "--- 판매소계 ---";

  // 헤더 도장
  lines.push({ kind: "text", text: "영 수 증 (공급받는자)", align: "center", bold: true, size: 2 });
  lines.push({ kind: "blank" });

  // 거래처 귀하 (우상)
  lines.push({ kind: "text", text: `${data.customerName} 귀하`, align: "right", bold: true });

  // 좌상 영수증번호 + 우상 출력일시
  const noLabel = receiptNoLabel(data.sessionSeq, data.receiptNo, !!data.isReprint);
  lines.push({ kind: "kv", left: noLabel, right: data.orderDate });
  lines.push({ kind: "rule", char: "=" });

  // 사업자정보
  pushBusinessHeader(lines, data);
  lines.push({ kind: "rule", char: "=" });

  // 영수증 본문 (상품/금액/소계/부가세/합계) — items 비어있으면 전체 skip (공란 처리).
  // 사장 결정 (2026-05-08): 영수증 재설계 전까지 출고/미송 영수증은 본문 공란 출력.
  // 미발송 명세서/샘플 전표는 영향 없음 (별도 builder).
  if (data.items.length > 0) {
    // 3컬럼 박스: 출고날짜 | 공급가 | 모드별 도장
    lines.push({ kind: "row3", left: data.shipDate, middle: krw(data.supply), right: stampLabel, bold: true });
    lines.push({ kind: "rule", char: "=" });

    // 항목 — 헤더 2줄 (품명 / 단가 수량 금액). 미송 처리된 항목은 ※ 표시.
    lines.push({ kind: "text", text: "품명", align: "left" });
    lines.push({ kind: "row3", left: "단가", middle: "수량", right: "금액" });
    lines.push({ kind: "rule", char: "_" });
    for (const it of data.items) {
      const prefix = it.isBackorder ? "※" : "";
      lines.push({ kind: "text", text: prefix + it.name + (it.option ? ` (${it.option})` : "") });
      lines.push({ kind: "row3", left: `  ${krw(it.unitPrice)}`, middle: `${it.qty}`, right: krw(it.amount) });
    }
    lines.push({ kind: "rule", char: "-" });

    // 소계 (모드별 헤더) + (부가세) + 합계
    lines.push({ kind: "row3", left: subtotalHeader, middle: `${data.items.length}건`, right: krw(data.supply) });
    if (data.vatInPayment && data.vat !== 0) {
      lines.push({ kind: "kv", left: "부가세", right: krw(data.vat) });
      if (data.paymentMethodKey === "credit") {
        // 청구거래처: 합계는 잔액박스 '당잔' 으로 갈음. 본문 합계 자리는 여백.
        lines.push({ kind: "blank" });
      } else {
        lines.push({ kind: "kv", left: "합 계", right: krw(data.total), bold: true });
      }
    }
    lines.push({ kind: "rule", char: "-" });
  }

  // 잔액 박스 (박제 있을 때) — 관리자 정책 2026-05-11:
  //   현금/통장: 4행 (전잔 / 당일합계 / 현금금액·통장입금 / 당잔) — 입금 받는 거래
  //   청구:      3행 (전잔 / 당일합계 / 당잔) — 입금 나중에 받음. 결제수단 라인 invisible.
  // 2026-05-12 사장 정책: 현금금액/통장입금 = 당일합계 동일 표기 (cash/transfer = 즉시결제 가정).
  //   부호 ± 모두 표기 (반품/환불 음수 거래 일관).
  if (data.balanceSnapshot) {
    const b = data.balanceSnapshot;
    const signed = (n: number) => (n >= 0 ? `+${krw(n)}` : krw(n));
    lines.push({ kind: "kv", left: "전 잔",   right: krw(b.prevBalance) });
    lines.push({ kind: "kv", left: "당일합계", right: krw(b.dayTotal) });
    if (b.paymentMethod !== "credit") {
      const methodLabel = b.paymentMethod === "cash" ? "현금금액" : "통장입금";
      lines.push({ kind: "kv", left: methodLabel, right: signed(b.dayTotal) });
    }
    lines.push({ kind: "kv", left: "당 잔",   right: krw(b.postBalance), bold: true });
  } else if (data.outstanding > 0) {
    lines.push({ kind: "kv", left: "외상잔액", right: krw(data.outstanding) });
  } else if (data.outstanding < 0) {
    lines.push({ kind: "kv", left: "매입잔액", right: krw(-data.outstanding) });
  }

  // 미발송 잔량 박스 — derived 주문일 때만 표시 (data.unshippedFromOriginal 있으면).
  // 일반 출고는 derived_from_order_id 가 없어 API 가 이 데이터를 안 채움 → 자연스레 미표시.
  const unshipped = data.unshippedFromOriginal;
  if (unshipped && unshipped.length > 0) {
    lines.push({ kind: "rule", char: "_" });
    lines.push({ kind: "blank" });
    lines.push({ kind: "kv", left: "[미발송 계]", right: "수량", bold: true });
    lines.push({ kind: "rule", char: "_" });
    for (const it of unshipped) {
      const label = it.name + (it.option ? ` (${it.option})` : "");
      lines.push({ kind: "kv", left: label, right: `${it.qty}` });
    }
    lines.push({ kind: "rule", char: "_" });
    lines.push({ kind: "blank" });
  } else {
    lines.push({ kind: "rule", char: "=" });
  }

  // 미송 항목 있을 때 안내 (※ 표시 부연)
  if (data.items.some(it => it.isBackorder)) {
    lines.push({ kind: "text", text: "※ 표시된 주문은 미송입니다.", align: "left" });
  }

  // orders.memo 는 시스템 자동 라벨 (디버그용). 양식 출력 X — 관리자 결정 2026-05-11.

  pushFooter(lines, opts, data);
  return { paperWidth: PAPER_WIDTH, charsPerLine: CHARS_PER_LINE, lines };
}

// ────────────────────────────────────────────────────────────────────
// 3) 미발송 명세서
// ────────────────────────────────────────────────────────────────────
export function buildPendingDoc(data: PendingData): ReceiptDoc {
  const lines: ReceiptLine[] = [];
  const opts = mergeOpts(DEFAULTS_PENDING, data.options);

  if (data.documentNo) lines.push({ kind: "text", text: data.documentNo, align: "right" });
  lines.push({ kind: "text", text: data.title, align: "center", bold: true, size: 2 });
  lines.push({ kind: "blank" });

  pushBusinessHeader(lines, data);
  lines.push({ kind: "rule", char: "=" });

  lines.push({ kind: "kv", left: "발행일자", right: data.documentDate });
  lines.push({ kind: "kv", left: "거래처",   right: data.customerName });
  lines.push({ kind: "rule", char: "-" });

  lines.push({ kind: "row3", left: data.documentDate.slice(0, 10), middle: krw(data.totalAmount), right: data.stampLabel, bold: true });
  lines.push({ kind: "rule", char: "-" });

  if (data.sections && data.sections.length > 0) {
    for (let si = 0; si < data.sections.length; si++) {
      const sec = data.sections[si];
      if (si > 0) lines.push({ kind: "blank" });
      lines.push({ kind: "text", text: `[ ${sec.label} ]`, align: "left", bold: true });
      lines.push({ kind: "text", text: "품명", align: "left" });
      lines.push({ kind: "row3", left: "단가", middle: "수량", right: "판매일자" });
      lines.push({ kind: "rule", char: "_" });
      for (const it of sec.items) {
        lines.push({ kind: "text", text: it.name + (it.option ? ` (${it.option})` : "") });
        lines.push({ kind: "row3", left: `  ${krw(it.unitPrice)}`, middle: `${it.qty}`, right: it.registeredDate ?? "-" });
      }
      lines.push({ kind: "rule", char: "-" });
      lines.push({ kind: "row3", left: `--- ${sec.label}소계 ---`, middle: `${sec.subCount}건 ${sec.subQty}`, right: krw(sec.subAmount) });
    }
    lines.push({ kind: "rule", char: "=" });
    lines.push({ kind: "row3", left: "=== 미발송 합계 ===", middle: `${data.totalCount}건 ${data.totalQty}`, right: krw(data.totalAmount) });
    lines.push({ kind: "rule", char: "=" });
  } else {
    lines.push({ kind: "text", text: "품명", align: "left" });
    lines.push({ kind: "row3", left: "단가", middle: "수량", right: "판매일자" });
    lines.push({ kind: "rule", char: "_" });
    for (const it of data.items) {
      lines.push({ kind: "text", text: it.name + (it.option ? ` (${it.option})` : "") });
      lines.push({ kind: "row3", left: `  ${krw(it.unitPrice)}`, middle: `${it.qty}`, right: it.registeredDate ?? "-" });
    }
    lines.push({ kind: "rule", char: "-" });
    const subtotalLabel = data.stampLabel === "발송" ? "발송소계" : "미발송소계";
    lines.push({ kind: "row3", left: `--- ${subtotalLabel} ---`, middle: `${data.totalCount}건 ${data.totalQty}`, right: krw(data.totalAmount) });
    lines.push({ kind: "rule", char: "=" });
  }

  if (data.vatNote && !data.options?.vatNoteText) opts.vatNoteText = data.vatNote;
  pushFooter(lines, opts, data);
  return { paperWidth: PAPER_WIDTH, charsPerLine: CHARS_PER_LINE, lines };
}

// ────────────────────────────────────────────────────────────────────
// 4) 샘플 명세서 (신규)
// ────────────────────────────────────────────────────────────────────
export function buildSampleDoc(data: SampleData): ReceiptDoc {
  const lines: ReceiptLine[] = [];
  const opts = mergeOpts(DEFAULTS_SAMPLE, data.options);

  if (data.documentNo) lines.push({ kind: "text", text: data.documentNo, align: "right" });
  // 헤더 박제 — 호출자가 어디서 부르든 동일한 "샘플 전표" 명칭.
  // 사장 명시 (2026-05-06): "하나의 Form 을 여러 페이지에서 적용. 수정은 한 곳."
  lines.push({ kind: "text", text: "샘플 전표", align: "center", bold: true, size: 2 });
  lines.push({ kind: "blank" });

  // 거래처 귀하 + 발행일시 (영수증과 동일 패턴, 좌측 라벨 없이 우측 정렬)
  lines.push({ kind: "text", text: `${data.customerName} 귀하`, align: "right", bold: true });
  lines.push({ kind: "text", text: data.documentDate, align: "right" });
  lines.push({ kind: "rule", char: "=" });

  pushBusinessHeader(lines, data);
  lines.push({ kind: "rule", char: "=" });

  // 도장 박스
  const dateLabel = data.shipDate ?? data.documentDate.slice(0, 10);
  lines.push({ kind: "row3", left: dateLabel, middle: krw(data.totalAmount), right: data.stampLabel, bold: true });
  lines.push({ kind: "rule", char: "=" });

  // 항목
  lines.push({ kind: "text", text: "품명", align: "left" });
  lines.push({ kind: "row3", left: "단가", middle: "수량", right: "금액" });
  lines.push({ kind: "rule", char: "_" });
  for (const it of data.items) {
    lines.push({ kind: "text", text: it.name + (it.option ? ` (${it.option})` : "") });
    lines.push({ kind: "row3", left: `  ${krw(it.unitPrice)}`, middle: `${it.qty}`, right: krw(it.amount) });
  }
  lines.push({ kind: "rule", char: "-" });

  lines.push({ kind: "row3", left: "--- 샘플소계 ---", middle: `${data.totalCount}건 ${data.totalQty}`, right: krw(data.totalAmount) });
  lines.push({ kind: "rule", char: "=" });

  // orders.memo 는 시스템 자동 라벨 (디버그용). 양식 출력 X — 관리자 결정 2026-05-11.

  pushFooter(lines, opts, data);
  return { paperWidth: PAPER_WIDTH, charsPerLine: CHARS_PER_LINE, lines };
}
