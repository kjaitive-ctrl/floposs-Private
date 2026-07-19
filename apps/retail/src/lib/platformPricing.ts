// 판매채널(sales_platforms)별 가격 환산 — /products 가격 토글.
// 마이그 215. 공식은 사장 결정 (2026-07-09): 역산으로 마진 보존, VAT 구분 없음.

export type PlatformCurrency = "KRW" | "JPY" | "USD";

export type Platform = {
  id: string;
  name: string;
  fee_rate: number;
  currency: PlatformCurrency;
};

export type FxRates = {
  usd: number | null;
  jpy: number | null;
};

// 기준가(원화) → 플랫폼 표시가. 표시가 = 기준가 / (1 - 수수료%).
// 통화가 KRW 아니면 환율로 나눔. 환율 미설정이면 null (호출부가 "환율 설정 필요" 처리).
export function convertToPlatformPrice(baseKrw: number, platform: Platform, fx: FxRates): number | null {
  const markedUp = baseKrw / (1 - platform.fee_rate / 100);
  if (platform.currency === "KRW") return markedUp;
  const rate = platform.currency === "USD" ? fx.usd : fx.jpy;
  if (!rate) return null;
  return markedUp / rate;
}

export function formatPlatformPrice(value: number, currency: PlatformCurrency): string {
  const symbol = currency === "KRW" ? "₩" : currency === "JPY" ? "¥" : "$";
  const decimals = currency === "USD" ? 2 : 0;
  return symbol + value.toLocaleString("en-US", { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}
