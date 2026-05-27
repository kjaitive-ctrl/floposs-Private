export const STATUS_LABEL: Record<string, string> = {
  pending: "주문접수",
  confirmed: "확인",
  in_production: "생산중",
  ready: "출고준비",
  shipped: "출고",
  delivered: "완료",
  cancelled: "취소",
};

export const STATUS_COLOR: Record<string, string> = {
  pending: "bg-yellow-100 text-yellow-700",
  confirmed: "bg-primary-soft-hover text-primary-hover",
  in_production: "bg-purple-100 text-purple-700",
  ready: "bg-orange-100 text-orange-700",
  shipped: "bg-green-100 text-green-700",
  delivered: "bg-gray-100 text-gray-600",
  cancelled: "bg-red-100 text-red-500",
};

export const PAY_LABEL: Record<string, string> = {
  cash: "현금",
  transfer: "통장입금",
  credit: "외상",
};

export const ITEM_TYPE_LABEL: Record<string, string> = {
  ship: "출고",
  backorder: "미송",
  backorder_shipped: "미송출고",
  order: "보류",
  sample: "샘플",
};

export const ITEM_TYPE_COLOR: Record<string, string> = {
  ship: "bg-green-100 text-green-700",
  backorder: "bg-orange-100 text-orange-600",
  backorder_shipped: "bg-green-100 text-green-700",
  order: "bg-purple-100 text-purple-600",
  sample: "bg-pink-100 text-pink-600",
};
