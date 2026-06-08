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

// 레거시 4자리 PIN 검증 — 로그인 완화용으로만 유지(기존 가입자 보호).
export function isValidPin(pin: string): boolean {
  return /^\d{4}$/.test(pin);
}

// 신규 비밀번호 정책: 8자 이상 + 영문 + 숫자 + 특수문자.
export function isValidPassword(pw: string): boolean {
  return (
    pw.length >= 8 &&
    /[A-Za-z]/.test(pw) &&
    /\d/.test(pw) &&
    /[^A-Za-z0-9]/.test(pw)
  );
}

export const PASSWORD_RULE_MSG = "비밀번호는 영문·숫자·특수문자를 포함해 8자 이상으로 설정해주세요.";

// 로그인 입력 완화 검증 — 레거시 4자리 ∪ 신규 복잡 비번 모두 통과.
// 실제 일치 판정은 Supabase Auth 가 함. 여기선 명백히 빈/짧은 값만 거름.
export function isLoginSecretShape(pw: string): boolean {
  return pw.length >= 4;
}

// 사업자등록번호 — 저장은 숫자만(문자열, 앞자리 0 보존), 표시는 XXX-XX-XXXXX.
// onlyDigits: 입력값에서 숫자만 추출 (최대 10자리) → DB 저장용.
export function bizNumberDigits(value: string): string {
  return value.replace(/\D/g, "").slice(0, 10);
}

// 표시용 하이픈 포맷. 자리수가 덜 차도 부분 포맷 (입력 중 표시).
export function formatBizNumber(value: string | null | undefined): string {
  const d = bizNumberDigits(value ?? "");
  if (d.length <= 3) return d;
  if (d.length <= 5) return `${d.slice(0, 3)}-${d.slice(3)}`;
  return `${d.slice(0, 3)}-${d.slice(3, 5)}-${d.slice(5)}`;
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
  // 3축 옵션 + 내(소비자) 옵션 라벨 — 안건3 C3 표시용. optional (옛 API 응답엔 없음).
  option3?: string | null;
  barcode?: string | null;          // variant 바코드 (전자노트 식별 소켓, C4)
  consumer_color?: string | null;
  consumer_size?: string | null;
  consumer_option3?: string | null;
}

export interface PortalProduct {
  product_id: string;
  product_name: string;
  product_code: string | null;
  consumer_name?: string | null;   // 내 상품명 — 안건3 C3 (마이그 186, optional)
  variants: ProductOption[];
}

export interface SubmitItem {
  variant_id: string;
  quantity: number;
}
