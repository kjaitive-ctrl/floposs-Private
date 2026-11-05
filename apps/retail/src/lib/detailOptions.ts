// 상세페이지 선택 항목 (products.detail_options, 마이그 236).
// 멘트 창(CommentModal)에서 고르고 카페24 전송(api/cafe24/push)에서 표시. 항목 추가/문구 변경은 여기 한 곳만.
// DB에는 키만 저장 — 문구를 바꿔도 기존 상품 선택값이 유지됨.

// 칸 순서 = 기온 순서 (사장 결정 2026-11-05). background = 선택된 칸의 인라인 CSS.
export const SEASON_OPTIONS = [
  { key: "summer", label: "여름", en: "Summer", background: "background:#9CCBEA;" },
  { key: "spring_autumn", label: "봄/가을", en: "Spring / Autumn", background: "background:#D5A890;background:linear-gradient(90deg,#F4C6D2,#B58A66);" },
  { key: "winter", label: "겨울", en: "Winter", background: "background:#E6D5B0;" },
];

export const WASH_OPTIONS = [
  { key: "dry", label: "드라이클리닝" },
  { key: "hand", label: "단독 손세탁" },
  { key: "machine", label: "단독 기계세탁" },
];

export const CAUTION_OPTIONS = [
  { key: "bleed", label: "이염주의", text: "마찰이나 물세탁으로 이염될 수 있으니 밝은 의류와 분리해 주세요." },
  { key: "pilling", label: "보풀주의", text: "마찰이 잦은 부위에 보풀이 생길 수 있습니다." },
  { key: "shrink", label: "수축주의", text: "고온 세탁과 건조 시 줄어들 수 있습니다." },
  { key: "wrinkle", label: "구김주의", text: "소재 특성상 구김이 생기기 쉽습니다." },
];

export const SEASON_NOTE_MAX = 30;

export type DetailOptions = {
  seasons: string[];
  season_note: string;
  washes: string[];
  cautions: string[];
};

function validKeys(raw: unknown, options: { key: string }[]): string[] {
  if (!Array.isArray(raw)) return [];
  return options.filter(o => raw.includes(o.key)).map(o => o.key);
}

// DB 값 → 안전한 형태. 빈 값/옛 값/목록에서 사라진 키 모두 걸러냄.
export function normalizeDetailOptions(raw: unknown): DetailOptions {
  const o = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
  return {
    seasons: validKeys(o.seasons, SEASON_OPTIONS),
    season_note: typeof o.season_note === "string" ? o.season_note.trim() : "",
    washes: validKeys(o.washes, WASH_OPTIONS),
    cautions: validKeys(o.cautions, CAUTION_OPTIONS),
  };
}

// 멘트 버튼 표시용 — 상세페이지에 실제로 나갈 값이 있는지.
export function hasDetailOptions(raw: unknown): boolean {
  const o = normalizeDetailOptions(raw);
  return o.seasons.length > 0 || o.washes.length > 0 || o.cautions.length > 0;
}
