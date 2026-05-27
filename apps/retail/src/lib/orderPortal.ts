// 외부 주문 포털 공통 유틸 + 타입.

export const ORDER_PORTAL_EMAIL_DOMAIN = "order-portal.local";

// 휴대폰 → dummy email 변환 (Supabase Auth password 로그인용)
// 입력: "010-1234-5678" 또는 "01012345678" → "01012345678@order-portal.local"
export function phoneToEmail(phone: string): string {
  const digits = phone.replace(/\D+/g, "");
  return `${digits}@${ORDER_PORTAL_EMAIL_DOMAIN}`;
}

export function normalizePhone(phone: string): string {
  return phone.replace(/\D+/g, "");
}

export function isValidPhone(phone: string): boolean {
  const d = normalizePhone(phone);
  return /^010\d{8}$/.test(d);
}

export function isValidPin(pin: string): boolean {
  return /^\d{4}$/.test(pin);
}

// 타입 ----------------------------------------------------

export type PaymentMethod = "cash" | "transfer" | "credit";

export interface OrderPortalTenant {
  id: string;
  company_name: string;
  owner_name: string | null;
  phone: string | null;
  address: string | null;
  default_payment_method: PaymentMethod | null;
}

export interface WholesaleTenantBrief {
  id: string;
  company_name: string;
  owner_name: string | null;
  phone: string | null;
  address: string | null;
}

export interface ProductOption {
  variant_id: string;
  color: string | null;
  size: string | null;
  // 단가: wholesale 측 상품관리에서 박힌 default 단가.
  // retail UI 표시는 정책에 따라 off 가능 (현재 v1 정책 = 숨김).
  // 인프라적으로는 항상 흐름 (staging 박제 + 미처리 탭 표시 + derived 매출 박제).
  unit_price: number;
}

export interface PortalProduct {
  product_id: string;
  product_name: string;
  product_code: string | null;
  variants: ProductOption[];
}

export interface SubmitItem {
  variant_id: string;
  quantity: number;
}
