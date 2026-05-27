// 도메인 공통 타입 — 페이지마다 따로 선언하던 것을 여기로 통합.
//
// 각 페이지는 필요한 필드만 골라쓰려면 Pick 사용:
//   type CustomerSummary = Pick<Customer, "id" | "company_name" | "outstanding_balance">;
//
// supabase customers 테이블 스키마를 그대로 반영. 새 컬럼 추가시 여기에만 반영하면
// 모든 사용처 타입이 따라온다.

export type Customer = {
  id: string;
  company_name: string;
  business_name: string | null;
  business_number: string | null;
  tax_email: string | null;
  owner_name: string | null;
  phone: string | null;
  email: string | null;
  address: string | null;
  contact1_name: string | null;
  contact1_phone: string | null;
  contact1_role: string | null;
  contact2_name: string | null;
  contact2_phone: string | null;
  contact2_role: string | null;
  buyer_name: string | null;
  buyer_phone: string | null;
  region: string | null;                   // 170: 지역 (자유 입력)
  business_form: "online" | "offline" | "etc" | null;  // 170: 형태
  credit_limit: number;
  outstanding_balance: number;             // 159: supply only (vat 분리)
  outstanding_vat?: number;                // 159: 청구거래처에서만 누적 (받지 않은 vat)
  include_vat: boolean;
  default_payment_method: string;
  memo: string | null;
  is_active: boolean;
  linked_tenant_id: string | null;          // 175: retail tenant 연동 — 외부 주문 포털 v1. NOT NULL 이면 결제수단 wholesale 측 변경 불가 (정책 2026-05-15).
};
