"use client";
import { formatComma } from "@/lib/format";
import { formatPlatformPrice, type PlatformCurrency } from "@/lib/platformPricing";

const FIXED_FEE_KRW = 2200;

interface Props {
  productName: string;
  sellPrice: number | null;       // 해당 채널 통화 기준 상시판매가 (실제 리스팅가 — 마크업 반영됨)
  wholesalePrice: number | null;  // 도매가 — 항상 원화 원본 (환산은 아래서 fxRate 로)
  feeRatePercent: number;         // 채널별 수수료 % (카페24=3.5 고정, 등록 채널=실제 전체 수수료율)
  currency: PlatformCurrency;
  fxRate: number | null;          // KRW→currency 환율. currency=KRW 면 무시. 채널 통화인데 미설정이면 null.
  onClose: () => void;
}

// 수수료 = 상시판매가(해당통화) × 수수료% + 2,200원(고정, 해당통화로 환산)
// 마진   = 상시판매가 − 수수료 − 도매가(해당통화로 환산)
function calcFee(sell: number, feeRatePercent: number, fixedFee: number): number {
  return Math.round(sell * (feeRatePercent / 100) + fixedFee);
}

export default function MarginCalcModal({ productName, sellPrice, wholesalePrice, feeRatePercent, currency, fxRate, onClose }: Props) {
  const needsFx = currency !== "KRW";
  const fxMissing = needsFx && !fxRate;

  const sell = sellPrice ?? 0;
  const costRaw = wholesalePrice ?? 0;
  const cost = needsFx ? (fxRate ? costRaw / fxRate : 0) : costRaw;
  const fixedFee = needsFx ? (fxRate ? FIXED_FEE_KRW / fxRate : 0) : FIXED_FEE_KRW;

  const fee = sell > 0 ? calcFee(sell, feeRatePercent, fixedFee) : 0;
  const margin = sell - fee - cost;
  const rateStr = sell > 0 && costRaw > 0 && !fxMissing ? (margin / sell * 100).toFixed(1) + "%" : null;

  const hasData = sell > 0 && costRaw > 0 && !fxMissing;
  const fmt = (v: number) => formatPlatformPrice(v, currency);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30"
      onMouseDown={onClose}>
      <div className="bg-white rounded-xl shadow-xl p-5 w-64 space-y-3"
        onMouseDown={e => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <h3 className="font-semibold text-sm text-gray-800">마진 계산</h3>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-lg leading-none">×</button>
        </div>

        {productName && <p className="text-xs text-gray-400 truncate">{productName}</p>}

        <div className="space-y-1.5 text-sm">
          <div className="flex justify-between items-baseline">
            <span className="text-gray-500">상시판매가</span>
            <span className="font-medium">{sell > 0 ? fmt(sell) : "—"}</span>
          </div>
          <div className="flex justify-between items-baseline">
            <span className="text-gray-500">수수료 ({feeRatePercent}% + ₩{formatComma(FIXED_FEE_KRW)})</span>
            <span className={`font-medium ${fee >= 0 ? "text-rose-600" : "text-blue-600"}`}>
              {sell > 0 ? (fee >= 0 ? "−" : "+") + fmt(Math.abs(fee)) : "—"}
            </span>
          </div>
          <div className="flex justify-between items-baseline">
            <span className="text-gray-500">도매가</span>
            <span className="font-medium text-rose-600">
              {fxMissing
                ? <span className="text-orange-500 text-xs">환율 설정 필요</span>
                : costRaw > 0 ? "−" + fmt(cost) : "—"}
            </span>
          </div>
          <div className="border-t border-gray-100 pt-1.5 flex justify-between items-baseline">
            <span className="font-semibold">순마진</span>
            {hasData ? (
              <div className="text-right">
                <span className={`font-bold ${margin >= 0 ? "text-emerald-600" : "text-red-600"}`}>
                  {fmt(margin)}
                </span>
                {rateStr && (
                  <span className={`ml-1.5 text-xs font-medium ${margin >= 0 ? "text-emerald-500" : "text-red-500"}`}>
                    ({rateStr})
                  </span>
                )}
              </div>
            ) : (
              <span className="text-xs text-gray-400">—</span>
            )}
          </div>
        </div>

        {!hasData && !fxMissing && (
          <p className="text-xs text-orange-500">
            {!sell ? "상시판매가" : "도매가"}가 입력되지 않았습니다
          </p>
        )}
        {fxMissing && (
          <p className="text-xs text-orange-500">
            설정에서 {currency} 환율을 먼저 등록해주세요
          </p>
        )}
      </div>
    </div>
  );
}
