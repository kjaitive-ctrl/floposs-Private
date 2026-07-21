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

// 카페24(기본/원화, id="") 자체의 마진계산용 수수료 가정치. 사장 결정 2026-07-09.
// 가격표시(판매가/소비자가/상시판매가 입력값)엔 적용 안 함 — 마진계산 모달 전용.
export const CAFE24_FEE_RATE = 3.5;

// 마진계산 고정 수수료(원화). MarginCalcModal + /products 마진율 색상 양쪽에서 공용.
export const FIXED_FEE_KRW = 2200;

// 수수료 = 판매가(해당통화) × 수수료% + 고정수수료(해당통화로 환산).
export function calcFee(sell: number, feeRatePercent: number, fixedFee: number): number {
  return Math.round(sell * (feeRatePercent / 100) + fixedFee);
}

// 기준가(원화) → 플랫폼 표시가.
// 원화 플랫폼: 표시가 = 기준가 / (1 - 플랫폼수수료% 전체) — 기존 공식 그대로.
// 외화 플랫폼 (사장 결정 2026-07-20, 수정 2026-07-20): 먼저 순수 환율변환 후,
//   카페24 기본(3.5%)보다 높아진 초과분만큼 그 위에 얹어서 가산 —
//   표시가 = (기준가 / 환율) x (1 + max(0, 플랫폼수수료% - 3.5%) / 100).
//   예: 10000원, 60%수수료 31.9%, 환율 X → (10000/X) x (1 + (31.9-3.5)/100) = (10000/X) x 1.284
//   환율 미설정이면 null (호출부가 "환율 설정 필요" 처리).
//   엔화는 지저분한 끝자리 방지를 위해 10엔 단위 반올림.
export function convertToPlatformPrice(baseKrw: number, platform: Platform, fx: FxRates): number | null {
  if (platform.currency === "KRW") {
    return baseKrw / (1 - platform.fee_rate / 100);
  }
  const rate = platform.currency === "USD" ? fx.usd : fx.jpy;
  if (!rate) return null;
  const baseInCurrency = baseKrw / rate;
  const extraFee = Math.max(0, platform.fee_rate - CAFE24_FEE_RATE);
  const converted = baseInCurrency * (1 + extraFee / 100);
  if (platform.currency === "JPY") return Math.round(converted / 10) * 10;
  return converted;
}

export function formatPlatformPrice(value: number, currency: PlatformCurrency): string {
  const symbol = currency === "KRW" ? "₩" : currency === "JPY" ? "¥" : "$";
  const decimals = currency === "USD" ? 2 : 0;
  return symbol + value.toLocaleString("en-US", { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

// 마진계산 모달용 fee 컨텍스트. platform=null(카페24) 이면 고정 3.5%/원화.
// 마진계산의 "상시판매가"는 convertToPlatformPrice 로 마크업된(실제 리스팅) 값을 그대로 쓰고,
// 수수료도 해당 플랫폼의 실제 전체 수수료율을 그대로 차감 — "판매가를 수수료차이만큼 올려서
// 실제 수수료를 다 떼고도 적정마진이 남는지"를 순수하게 계산 (사장 결정 2026-07-20).
export function feeContextFor(platform: Platform | null, fx: FxRates): {
  feeRate: number; currency: PlatformCurrency; fxRate: number | null;
} {
  if (!platform) return { feeRate: CAFE24_FEE_RATE, currency: "KRW", fxRate: null };
  const fxRate = platform.currency === "KRW" ? null : (platform.currency === "USD" ? fx.usd : fx.jpy);
  return { feeRate: platform.fee_rate, currency: platform.currency, fxRate };
}
