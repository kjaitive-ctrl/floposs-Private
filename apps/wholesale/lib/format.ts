// 날짜 기준 타임존 — 여기만 바꾸면 전체 적용
export const APP_TIMEZONE = "Asia/Seoul";

export function krw(amount: number): string {
  return amount.toLocaleString();
}

// YYYY-MM-DD (APP_TIMEZONE 기준)
export function toDateStr(d: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: APP_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

// 오늘 날짜 YYYY-MM-DD
export function today(): string {
  return toDateStr();
}

// 오늘 기준 n일 오프셋 (예: -1 = 어제)
export function tzDateOffset(offsetDays: number): string {
  const [y, m, d] = toDateStr().split("-").map(Number);
  const dt = new Date(y, m - 1, d + offsetDays);
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}-${String(dt.getDate()).padStart(2, "0")}`;
}

// 월의 첫날 (monthOffset: 0=이번달, -1=저번달)
export function tzMonthStart(monthOffset = 0): string {
  const [y, m] = toDateStr().split("-").map(Number);
  const dt = new Date(y, m - 1 + monthOffset, 1);
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}-01`;
}

// 월의 마지막날 (monthOffset: 0=이번달, -1=저번달)
export function tzMonthEnd(monthOffset = 0): string {
  const [y, m] = toDateStr().split("-").map(Number);
  const dt = new Date(y, m + monthOffset, 0);
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}-${String(dt.getDate()).padStart(2, "0")}`;
}

export function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("ko-KR", { timeZone: APP_TIMEZONE });
}

export function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString("ko-KR", { timeZone: APP_TIMEZONE });
}

// 알파벳 24자 (I, O 제외 — 숫자 1, 0과 혼동 방지)
const PROD_ALPHA = "ABCDEFGHJKLMNPQRSTUVWXYZ";
const PROD_BLOCK = 100_000_000; // 알파벳 prefix 1쌍당 1억

// 상품번호: AA00000001 형식 (알파벳2 + 숫자8, 최대 576억)
export function formatProductNo(no: number | null | undefined): string {
  if (no == null) return "-";
  const prefixIdx = Math.floor(no / PROD_BLOCK);
  const numPart = no % PROD_BLOCK;
  const first = PROD_ALPHA[Math.floor(prefixIdx / 24)] ?? "?";
  const second = PROD_ALPHA[prefixIdx % 24] ?? "?";
  return `${first}${second}${String(numPart).padStart(8, "0")}`;
}

// AA00000001 형식 → product_no 숫자로 역변환 (검색용)
export function parseProductNo(str: string): number | null {
  const match = str.trim().toUpperCase().match(/^([A-Z]{2})(\d{8})$/);
  if (!match) return null;
  const [, prefix, digits] = match;
  const firstIdx = PROD_ALPHA.indexOf(prefix[0]);
  const secondIdx = PROD_ALPHA.indexOf(prefix[1]);
  if (firstIdx === -1 || secondIdx === -1) return null;
  return (firstIdx * 24 + secondIdx) * PROD_BLOCK + parseInt(digits, 10);
}

// SKU: 상품번호(10자) + 옵션순번(3자) = 13자리  예) AA00000001001
export function formatSku(productNo: number | null | undefined, variantSku: string | null | undefined): string {
  if (productNo == null || !variantSku || variantSku === "-") return "-";
  return formatProductNo(productNo) + variantSku.padStart(3, "0");
}

// 날짜 문자열 → KST 타임스탬프 범위 (Supabase 쿼리용)
export function toKstRange(from: string, to: string): { fromTs: string; toTs: string } {
  return {
    fromTs: from + "T00:00:00+09:00",
    toTs:   to   + "T23:59:59+09:00",
  };
}

// 날짜 프리셋
export const DATE_PRESETS = [
  { key: "today",     label: "오늘" },
  { key: "yesterday", label: "어제" },
  { key: "week",      label: "일주일" },
  { key: "month",     label: "이번달" },
  { key: "lastmonth", label: "저번달" },
] as const;

export type DatePresetKey = typeof DATE_PRESETS[number]["key"];

export function getPresetRange(preset: string): [string, string] {
  const t = today();
  switch (preset) {
    case "today":     return [t, t];
    case "yesterday": { const y = tzDateOffset(-1); return [y, y]; }
    case "week":      return [tzDateOffset(-6), t];
    case "month":     return [tzMonthStart(0), t];
    case "lastmonth": return [tzMonthStart(-1), tzMonthEnd(-1)];
    default: return ["", ""];
  }
}

// ── 결제수단 라벨 ─────────────────────────────────────────────
export const METHOD_LABELS: Record<string, string> = {
  cash: "현금",
  transfer: "통장",
  credit: "청구",
};

// ── KST 날짜 포맷 (route 들에서 중복 정의 통합) ────────────────
// YYYY-MM-DD
export function formatKstDateOnly(iso: string): string {
  const d = new Date(iso);
  const kst = new Date(d.getTime() + 9 * 3600 * 1000);
  const yyyy = kst.getUTCFullYear();
  const mm = String(kst.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(kst.getUTCDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

// YYYY-MM-DD HH:mm
export function formatKstDateTime(iso: string): string {
  const d = new Date(iso);
  const kst = new Date(d.getTime() + 9 * 3600 * 1000);
  const yyyy = kst.getUTCFullYear();
  const mm = String(kst.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(kst.getUTCDate()).padStart(2, "0");
  const hh = String(kst.getUTCHours()).padStart(2, "0");
  const mi = String(kst.getUTCMinutes()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd} ${hh}:${mi}`;
}

// YY-MM-DD(요일) — 영수증 출고일 양식
export function formatKstShipDate(iso: string): string {
  const d = new Date(iso);
  const kst = new Date(d.getTime() + 9 * 3600 * 1000);
  const yy = String(kst.getUTCFullYear()).slice(-2);
  const mm = String(kst.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(kst.getUTCDate()).padStart(2, "0");
  const wd = ["일","월","화","수","목","금","토"][kst.getUTCDay()];
  return `${yy}-${mm}-${dd}(${wd})`;
}

// ── 외상 표시 (with_vat 합산 — include_vat 거래처) ──────────────
// DB 박제는 outstanding_balance (supply) / outstanding_vat (vat) 분리.
// 표시 시점에 청구거래처면 합산해서 노출.
export function displayOutstanding(c: {
  outstanding_balance?: number | null;
  outstanding_vat?: number | null;
  include_vat?: boolean | null;
}): number {
  return (c.outstanding_balance ?? 0) + (c.include_vat ? (c.outstanding_vat ?? 0) : 0);
}

export function formatOrderTime(iso: string): string {
  const parts = new Intl.DateTimeFormat("en", {
    timeZone: APP_TIMEZONE,
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(new Date(iso));
  const get = (t: string) => parts.find(p => p.type === t)?.value ?? "00";
  return `${get("month")}/${get("day")} ${get("hour")}:${get("minute")}`;
}
