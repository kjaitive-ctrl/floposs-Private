"use client";
import { formatComma } from "@/lib/format";

interface Props {
  productName: string;
  sellPrice: number | null;    // regular_sale_price
  wholesalePrice: number | null; // wholesale_price_current || wholesale_price
  onClose: () => void;
}

const FEE_RATE = 0.16;

export default function MarginCalcModal({ productName, sellPrice, wholesalePrice, onClose }: Props) {
  const sell = sellPrice ?? 0;
  const cost = wholesalePrice ?? 0;
  const fee = sell > 0 ? Math.round(sell * FEE_RATE) : 0;
  const margin = sell - cost - fee;
  const rateStr = sell > 0 && cost > 0 ? (margin / sell * 100).toFixed(1) + "%" : null;

  const hasData = sell > 0 && cost > 0;

  function row(label: string, value: number, negative?: boolean) {
    return (
      <div className="flex justify-between items-baseline text-sm">
        <span className="text-gray-500">{label}</span>
        <span className={negative ? "text-rose-600 font-medium" : "font-medium"}>
          {negative ? "−" : ""}{formatComma(value)}원
        </span>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30"
      onMouseDown={onClose}>
      <div className="bg-white rounded-xl shadow-xl p-5 w-64 space-y-3"
        onMouseDown={e => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <h3 className="font-semibold text-sm text-gray-800">마진 계산</h3>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-lg leading-none">×</button>
        </div>

        {productName && (
          <p className="text-xs text-gray-400 truncate">{productName}</p>
        )}

        <div className="space-y-1.5">
          {row("상시판매가", sell)}
          {row("도매 원가", cost, true)}
          {row(`수수료 (약 ${(FEE_RATE * 100).toFixed(0)}%)`, fee, true)}
          <div className="border-t border-gray-100 pt-1.5 flex justify-between items-baseline">
            <span className="font-semibold text-sm">순마진</span>
            {hasData ? (
              <div className="text-right">
                <span className={`font-bold text-sm ${margin >= 0 ? "text-emerald-600" : "text-red-600"}`}>
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
