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

// 부가세(원가, 마진 마이너스 항목). 사장 결정 2026-08-31.
// 원화: 상시판매가에 VAT 이미 포함 → 역산 추출 = 상시판매가 − (상시판매가 / 1.1).
// 외화(JPY/USD 등 해외채널, 예: 식스티퍼센트): 상시판매가에 VAT 미포함 → 판매가 × 10% 를 비용으로 가산.
export function calcVat(sell: number, currency: PlatformCurrency): number {
  if (currency === "KRW") return sell - sell / 1.1;
  return sell * 0.1;
}

// 순마진 = 상시판매가 − 수수료 − 도매가(해당통화로 환산) − 부가세.
// MarginCalcModal + /products 마진 칸 + 상품 정보 창 공용. rate 는 계산 가능할 때만 값이 있음.
export function calcMargin(
  sell: number,
  costKrw: number,  // 도매가 — 항상 원화 원본
  feeRatePercent: number,
  currency: PlatformCurrency,
  fxRate: number | null,
) {
  const needsFx = currency !== "KRW";
  const fxMissing = needsFx && !fxRate;
  const cost = needsFx ? (fxRate ? costKrw / fxRate : 0) : costKrw;
  const fixedFee = needsFx ? (fxRate ? FIXED_FEE_KRW / fxRate : 0) : FIXED_FEE_KRW;
  const fee = sell > 0 ? calcFee(sell, feeRatePercent, fixedFee) : 0;
  const vat = sell > 0 ? calcVat(sell, currency) : 0;
  const margin = sell - fee - cost - vat;
  const hasData = sell > 0 && costKrw > 0 && !fxMissing;
  return { fee, vat, cost, margin, fxMissing, hasData, rate: hasData ? margin / sell * 100 : null };
}

// [진행] 시 비어 있는 가격 자동 입력값. 최근 입력 가격(2026-05 이후 136개)에 맞춘 규칙 (사장 결정 2026-11-05).
// 2024-12 등록분은 무료배송비가 포함된 가격이라 기준에서 제외. 입력 후에는 표에서 자유롭게 수정.
//   상시판매가: 남길 금액 = 2,500원 + 도매가 × 25%. %만 쓰면 저가 상품에 남는 돈이 너무 적음. 100원 단위 반올림.
//   소비자가: 상시판매가 × 1.05, 1,000원 단위 올림.
const SUGGEST_BASE_MARGIN = 2500;
const SUGGEST_COST_RATIO = 0.25;
const SUGGEST_CONSUMER_RATIO = 1.05;

export function suggestRegularPrice(costKrw: number): number {
  const target = SUGGEST_BASE_MARGIN + costKrw * SUGGEST_COST_RATIO;
  // calcMargin(원화)을 판매가 기준으로 푼 식: 남는 돈 = 판매가 × (1/1.1 − 수수료%) − 고정수수료 − 도매가
  const raw = (costKrw + FIXED_FEE_KRW + target) / (1 / 1.1 - CAFE24_FEE_RATE / 100);
  return Math.round(raw / 100) * 100;
}

export function suggestConsumerPrice(regularPrice: number): number {
  return Math.ceil(regularPrice * SUGGEST_CONSUMER_RATIO / 1000) * 1000;
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
