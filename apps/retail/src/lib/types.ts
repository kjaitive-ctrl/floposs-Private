// 중앙 타입 — 자기 tenant 관련 공유 인터페이스.
// wholesale tenant 같은 외부 의미는 페이지 로컬에 박는다 (혼동 방지).

import type { PaymentMethod } from "./orderPortal";

// ── 구독 플랜 (subscription_plans nested) ──
export interface SubscriptionPlan {
  id: string;
  name: string;
  description: string | null;
  price: number;
  billing_cycle: string;
  features: string[];
}

// ── tenant 기본 (자주 필요한 필드 + 구독 가드용) ──
// TenantContext + /order/me + /order/* 등 가벼운 페이지가 사용.
export interface TenantBase {
  id: string;
  company_name: string;
  owner_name: string | null;
  phone: string | null;
  address: string | null;
  business_number: string | null;
  default_payment_method: PaymentMethod | null;
  // 마이그 189: 구독 가드용
  plan_id: string | null;
  subscription_expires_at: string | null;
}

// ── tenant 풀 (마이그 189 신규 6필드 + 구독 nested) ──
// /dashboard/settings + me API 가 select 하는 풀 정보.
export interface TenantFull extends TenantBase {
  tax_invoice_email: string | null;
  contact_email: string | null;
  warehouse_address: string | null;
  warehouse_same_as_office: boolean;
  warehouse_phone: string | null;
  store_name: string | null;
  store_url: string | null;
  cancel_at_period_end: boolean;
  subscription_plans: SubscriptionPlan | null;
}

// ── 외상 합계 (me API ?include=outstanding) ──
export interface OutstandingTotals {
  supply: number;
  vat: number;
  total_abs: number;
}
