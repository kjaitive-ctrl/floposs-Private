"use client";
import { formatComma } from "@/lib/format";

interface Props {
  productName: string;
  sellPrice: number | null;
  wholesalePrice: number | null;
  onClose: () => void;
}

// 수수료 = 상시판매가 × 11% + 2,200원
// 마진   = 상시판매가 − 수수료 − 도매가
function calcFee(sell: number): number {
  return Math.round(sell * 0.11 + 2200);
}

export default function MarginCalcModal({ productName, sellPrice, wholesalePrice, onClose }: Props) {
  const sell = sellPrice ?? 0;
  const cost = wholesalePrice ?? 0;
  const fee = sell > 0 ? calcFee(sell) : 0;
  const margin = sell - fee - cost;
  const rateStr = sell > 0 && cost > 0 ? (margin / sell * 100).toFixed(1) + "%" : null;

  const hasData = sell > 0 && cost > 0;

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
            <span className="font-medium">{sell > 0 ? formatComma(sell) + "원" : "—"}</span>
          </div>
          <div className="flex justify-between items-baseline">
            <span className="text-gray-500">수수료 (11% + 2,200원)</span>
            <span className={`font-medium ${fee >= 0 ? "text-rose-600" : "text-blue-600"}`}>
              {sell > 0 ? (fee >= 0 ? "−" : "+") + formatComma(Math.abs(fee)) + "원" : "—"}
            </span>
          </div>
          <div className="flex justify-between items-baseline">
            <span className="text-gray-500">도매가</span>
            <span className="font-medium text-rose-600">
              {cost > 0 ? "−" + formatComma(cost) + "원" : "—"}
            </span>
          </div>
          <div className="border-t border-gray-100 pt-1.5 flex justify-between items-baseline">
            <span className="font-semibold">순마진</span>
            {hasData ? (
              <div className="text-right">
                <span className={`font-bold ${margin >= 0 ? "text-emerald-600" : "text-red-600"}`}>
                  {formatComma(margin)}원
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

        {!hasData && (
          <p className="text-xs text-orange-500">
            {!sell ? "상시판매가" : "도매가"}가 입력되지 않았습니다
          </p>
        )}
      </div>
    </div>
  );
}
