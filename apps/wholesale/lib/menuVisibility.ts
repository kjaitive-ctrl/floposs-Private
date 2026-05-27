export type Role = "super_admin" | "tenant_admin" | "manager" | "staff";

// 운영 전환 시 everyone → adminOnly 로 한 단어만 변경하면 lock
const everyone: Role[]  = ["super_admin", "tenant_admin", "manager", "staff"];
const adminOnly: Role[] = ["super_admin", "tenant_admin"];
// 미래용 헬퍼 (예: 매니저 이상 가시)
const managerUp: Role[] = ["super_admin", "tenant_admin", "manager"];

void adminOnly;
void managerUp;

// menuKey 는 layout.tsx 의 sidebar menus[].key 와 1:1 매칭
// path 의 첫 segment 와도 매칭됨 (/dashboard/<segment>) — middleware 에서 사용
export const MENU_ACCESS: Record<string, Role[]> = {
  dashboard:          everyone,
  orders:             everyone,
  "orders-test":      everyone,
  products:           everyone,
  customers:          everyone,
  inventory:          everyone,
  transactions:       everyone,
  "sales-settlement": everyone,
  "vat-settlement":   everyone,    // 월별 부가세 정산 (세금계산서 기반 입금)
  "sales-report":     everyone,    // 매출리포트
  inquiries:          everyone,    // 문의 (사장+직원 모두 가능, 본인 tenant 본인 작성건만 노출)
  settings:           everyone,
};

export function canAccessMenu(role: Role | null | undefined, menuKey: string): boolean {
  if (!role) return false;
  const allowed = MENU_ACCESS[menuKey];
  return allowed ? allowed.includes(role) : true; // 정의 안 된 키는 기본 허용 (개발 안전)
}

// /dashboard 또는 /dashboard/orders/123 → "dashboard" / "orders"
export function pathToMenuKey(pathname: string): string | null {
  const m = pathname.match(/^\/dashboard(?:\/([^\/?#]+))?/);
  if (!m) return null;
  return m[1] ?? "dashboard";
}

export const ADMIN_ROLES: Role[] = ["super_admin", "tenant_admin"];
export function isAdminRole(role: Role | null | undefined): boolean {
  return !!role && ADMIN_ROLES.includes(role);
}
