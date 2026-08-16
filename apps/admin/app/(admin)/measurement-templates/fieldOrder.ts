// 측정 필드 마스터 순서 — 카테고리마다 필드 순서가 제각각이라 컬럼 위치가 흔들리던 문제 (2026-08-16).
// 저장 시점에 항상 이 순서로 정렬 → 모든 카테고리에서 같은 필드는 항상 같은 위치.
// 순서 갱신 시 여기 한 곳만 바꾸면 다음 저장부터 전 카테고리에 반영됨.
export const FIELD_ORDER: string[] = [
  "총장",
  "어깨단면", "어깨너비",
  "가슴단면",
  "허리단면",
  "힙단면",
  "허벅지단면",
  "밑위길이", "밑위",
  "소매길이",
  "암홀단면",
  "팔통단면",
  "소매단면",
  "밑단단면", "밑단너비",
  "목높이",
  "캡가로",
  "캡세로",
];

// 마스터 순서에 없는 필드(신규 칩)는 뒤에 붙되 서로간 상대 순서는 유지 (stable sort).
export function sortByFieldOrder(fields: string[]): string[] {
  return [...fields].sort((a, b) => {
    const ia = FIELD_ORDER.indexOf(a);
    const ib = FIELD_ORDER.indexOf(b);
    const ra = ia === -1 ? FIELD_ORDER.length : ia;
    const rb = ib === -1 ? FIELD_ORDER.length : ib;
    return ra - rb;
  });
}
