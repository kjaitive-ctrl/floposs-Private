// 상품 상태 라벨
export const STATUS_LABELS: Record<string, string> = {
  sample_received: "샘플수령",
  shooting_done: "촬영완료",
  registered: "등록완료",
  returned: "반납",
  inactive: "중단/품절",
};

// 페이지별 상태 필터
export const SAMPLE_STATUSES = ["sample_received", "shooting_done", "returned"];
export const PRODUCT_STATUSES = ["registered", "inactive"];

// 옵션 라벨 기본값 (NULL fallback)
export const DEFAULT_OPTION_LABEL = {
  option1: "색상",
  option2: "사이즈",
};
