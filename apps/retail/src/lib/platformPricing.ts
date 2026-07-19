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

// 카페24(기본/원화, id="") 자체의 마진계산용 수수료 가정치. 사장 결정 2026-07-09.
// 가격표시(판매가/소비자가/상시판매가 입력값)엔 적용 안 함 — 마진계산 모달 전용.
export const CAFE24_FEE_RATE = 3.5;

// 마진계산 모달용 fee 컨텍스트. platform=null(카페24) 이면 고정 3.5%/원화.
export function feeContextFor(platform: Platform | null, fx: FxRates): {
  feeRate: number; currency: PlatformCurrency; fxRate: number | null;
} {
  if (!platform) return { feeRate: CAFE24_FEE_RATE, currency: "KRW", fxRate: null };
  const fxRate = platform.currency === "KRW" ? null : (platform.currency === "USD" ? fx.usd : fx.jpy);
  return { feeRate: platform.fee_rate, currency: platform.currency, fxRate };
}

// 순수 환율 변환만 (수수료 역산 없이) — 마진계산 모달의 "해당통화 상시판매가" 표시용.
// convertToPlatformPrice 는 가격표시용이라 역산 마크업이 섞여있어 마진계산엔 부적합 (이중계산 방지).
export function toCurrencyOnly(baseKrw: number, currency: PlatformCurrency, fxRate: number | null): number | null {
  if (currency === "KRW") return baseKrw;
  if (!fxRate) return null;
  return baseKrw / fxRate;
}
