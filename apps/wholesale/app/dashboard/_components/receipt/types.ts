// 영수증 양식 타입 — 양식 자체는 코드 박제. 텍스트 슬롯 (푸터 등) + ON/OFF 토글만 tenant 단위 override.
// override 저장: tenants.receipt_text_overrides JSONB (마이그 112).

export type Align = "left" | "center" | "right";

export type ReceiptLine =
  | { kind: "text";    text: string;   align?: Align;   bold?: boolean;   size?: 1 | 2 | 3 }
  | { kind: "kv";      left: string;   right: string;   bold?: boolean }
  | { kind: "row3";    left: string;   middle: string;  right: string;   bold?: boolean;   size?: 1 | 2 }
  | { kind: "rule";    char?: "-" | "=" | "·" | "_" }
  | { kind: "blank"; }
  | { kind: "barcode"; value: string;  hri?: boolean }   // 주문번호 바코드 (Code128). default off — 양식별 토글로 켬.
  | { kind: "cut" };

export type ReceiptDoc = {
  paperWidth: 80;           // mm. 베타 기준 80mm 표준 (58mm 코드는 향후 도입 시 enum 확장).
  charsPerLine: number;     // 80mm = 42chars (typical)
  lines: ReceiptLine[];
};

// ── 양식별 푸터 옵션 (사장이 수정 가능) ─────────────────────────────
// 3 양식 (receipt/pending/sample) 모두 동일 키 셋. 양식별 default 다름.
// 저장 위치: tenants.receipt_text_overrides[양식키]
export type FormOptions = {
  customTop?:    string;    // 푸터1 자유 문단 (구분선 위)
  showOptions?:  boolean;   // 푸터2 — 옵션 (색상/사이즈 셋) 표시
  showMaterial?: boolean;   // 푸터2 — 혼용율 표시
  showBank1?:    boolean;   // 푸터3 — 메인 계좌 (default true)
  showBank2?:    boolean;   // 푸터3 — 서브 계좌
  showVatNote?:  boolean;   // 푸터3 — 부가세 안내 (default true)
  vatNoteText?:  string;    // 부가세 안내 텍스트 변경
  customBottom?: string;    // 푸터3 — 추가 문단
  showBarcode?:  boolean;   // 영수증번호 바코드 (default false — 미래 대비)
};

export type ReceiptOverrides = {
  receipt?: FormOptions;
  pending?: FormOptions;
  sample?:  FormOptions;
};

// ── 옵션/혼용율 데이터 (출력 시 fetch) ──────────────────────────────
// API 라우트가 order_items + products 에서 집계해서 builders 에 전달.
export type ProductExtra = {
  productName: string;
  colors:      string[];   // 주문에 포함된 색상 셋 (고유)
  sizes:       string[];   // 주문에 포함된 사이즈 셋
  material?:   string;     // 혼용율 (예: "면100" / "면80 폴리20")
};

export type BankInfo = { name: string; account: string; holder: string };

export type BusinessInfo = {
  businessName:   string;
  businessNumber: string | null;
  ceoName:        string | null;
  phone:          string | null;
  address:        string | null;
  businessType?:     string | null;   // 업태 (마이그 112)
  businessCategory?: string | null;   // 종목 (마이그 112)
  bankInfo?:    BankInfo | null;       // 메인 계좌 (필수)
  bankInfo2?:   BankInfo | null;       // 서브 계좌 (옵션)
};

export type ReceiptData = BusinessInfo & {
  // 거래
  orderNumber:   string;
  orderDate:     string;        // YYYY-MM-DD HH:mm (출력 시점)
  shipDate:      string;        // YYYY-MM-DD (출고날짜 — 3컬럼 박스 좌측)
  customerName:  string;
  paymentMethod: string;        // 현금/통장/청구
  paymentMethodKey: "cash" | "transfer" | "credit";
  // 항목
  items: Array<{
    name: string;
    qty: number;
    unitPrice: number;
    amount: number;
    option?: string;            // 색상/사이즈
    isBackorder?: boolean;      // 미송 처리된 항목 — 영수증에 ※ 표시
  }>;
  // 합계
  supply: number;               // 공급가 (판매소계) — 159 박제값 우선
  vat: number;                  // 부가세 (0이면 표시 X) — 159 박제값 우선
  total: number;                // 합계 — 159 박제값 우선
  outstanding: number;          // 박제 없을 때 폴백
  // 159 VAT 정공법: 영수증 표시 mode 박제값.
  //   true  → 합계 with_vat, 부가세 라인 표시, 잔액 4종 with_vat
  //   false → 합계 supply only, 부가세 라인 숨김, 잔액 4종 supply only
  // 박제 시점에 결정 (issue_receipt_snapshot). 재발행 시 동일.
  vatInPayment?: boolean;
  // 영수증 모드 (사장 정책 2026-05-06 단순화):
  //   'normal' : 모든 출고 (일반/미송 출고/보류 출고/샘플 결제 등). 도장 "영수"/"청구".
  //              미송 라인 ※ 표시는 items.isBackorder 자동.
  //              derived 출고 시 원주문 잔량은 unshippedFromOriginal 박스로 자동.
  //   'return' : 반품/교환 derived 음수 영수증. 도장 "반품", 본문 "--- 반품내역 ---".
  // default = 'normal'.
  mode?: "normal" | "return";
  // derived 주문일 때 원주문의 미발송 잔량 (있으면 잔량 박스 표시. 일반 출고는 derived_from_order_id 없어 자동 미표시).
  unshippedFromOriginal?: Array<{
    name: string;
    qty: number;
    option?: string;
  }>;
  // 영수증 박제 (Phase 3)
  receiptNo?:        string | null;   // 박제값 (R+YYYYMMDD+4자리)
  sessionSeq?:       number | null;   // 영업세션 내 영수증 발행 순번 (표시용 0001)
  isReprint?:        boolean;
  balanceSnapshot?: {
    prevBalance:    number;
    dayTotal:       number;
    paymentMethod:  "cash" | "transfer" | "credit";
    paymentAmount:  number;
    postBalance:    number;
  };
  // 푸터
  memo: string | null;
  // 푸터 동적 (옵션/혼용율 — show 토글 켜면 표시)
  productExtras?: ProductExtra[];
  // 양식 옵션 (override 적용된 최종값)
  options?: FormOptions;
};

// ── 미발송 양식 (미송 명세서) ─────────────────────────────────
// 영수증과 별도 form. 잔액 박스 X, 컬럼 = 단가/수량/판매일자.
export type PendingItem = {
  name: string;
  qty: number;
  unitPrice: number;
  amount: number;
  registeredDate?: string; // YYYY-MM-DD (등록일)
  option?: string;
};

export type PendingSection = {
  label: string;          // "미송" / "보류"
  items: PendingItem[];
  subCount: number;
  subQty: number;
  subAmount: number;
};

export type PendingData = BusinessInfo & {
  // 헤더
  title: string;             // "미발송내역" 등
  stampLabel: string;        // "미송" / "오더" 등
  customerName: string;
  documentNo?: string | null;
  documentDate: string;      // YYYY-MM-DD HH:mm (출력 시점)
  // 항목 (평면) — sections 없을 때 사용. sections 있으면 그랜드 합계용으로만.
  items: PendingItem[];
  // 합계 (잔액 X) — 항상 그랜드 합계
  totalCount: number;        // 건수 (항목 수)
  totalQty: number;          // 수량 합
  totalAmount: number;       // 금액 합
  // 섹션 분리 모드 (옵션) — 있으면 buildPendingDoc 가 섹션별로 렌더.
  // kind=all 거래처 미발송에서 미송+보류 둘 다 있을 때만 채움.
  sections?: PendingSection[];
  // 푸터 동적
  productExtras?: ProductExtra[];
  options?: FormOptions;
  /** @deprecated options.vatNoteText 로 통일. 기존 호출처 호환. */
  vatNote?: string | null;
};

// ── 샘플 전표 양식 ─────────────────────────────────────────────
// 잔액 박스 X (샘플 = 외상 변동 없음). 도장 "샘플".
// 옵션/혼용율 푸터 default ON (샘플 거래에서 자주 사용).
// 헤더는 template.ts 안 박제 ("샘플 전표") — 호출자의 title 은 무시됨.
export type SampleData = BusinessInfo & {
  /** @deprecated 헤더는 template.ts 박제. 이 필드는 무시됨. */
  title?: string;
  stampLabel: string;       // "샘플"
  customerName: string;
  documentNo?: string | null;
  documentDate: string;
  shipDate?: string;        // 샘플 출고일
  items: Array<{
    name: string;
    qty: number;
    unitPrice: number;
    amount: number;
    option?: string;
  }>;
  totalCount: number;
  totalQty: number;
  totalAmount: number;
  productExtras?: ProductExtra[];
  options?: FormOptions;
  memo?: string | null;
};
