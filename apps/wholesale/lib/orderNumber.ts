import { supabase } from "./supabase";
import { toDateStr } from "./format";

// ABCDEF-260420-0001 → 260420-0001 (화면 표시용)
export function displayOrderNumber(orderNumber: string): string {
  if (/^[A-Z]{6}-\d{6}-\d{4}$/.test(orderNumber)) {
    return orderNumber.slice(7);
  }
  return orderNumber; // 구형 SAL- 포맷 fallback
}

// 랜덤 대문자 6자리 생성 (신규 테넌트용)
export function generateTenantCode(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  return Array.from({ length: 6 }, () => chars[Math.floor(Math.random() * 26)]).join("");
}

// 판매번호 생성: ABCDEF-YYMMDD-NNNN
// 당일 마지막 순번 조회 후 +1, UNIQUE 충돌 시 호출부에서 재시도
export async function generateOrderNumber(tenantId: string, tenantCode: string): Promise<string> {
  const dateStr = toDateStr().slice(2).replace(/-/g, ""); // YYMMDD
  const prefix = `${tenantCode}-${dateStr}-`;

  // 당일 마지막 순번 조회
  const { data } = await supabase
    .from("orders")
    .select("order_number")
    .eq("tenant_id", tenantId)
    .like("order_number", `${prefix}%`)
    .order("order_number", { ascending: false })
    .limit(1);

  const lastSeq = data?.[0]
    ? parseInt(data[0].order_number.split("-")[2], 10)
    : 0;

  const seq = String(lastSeq + 1).padStart(4, "0");
  return `${prefix}${seq}`;
}
