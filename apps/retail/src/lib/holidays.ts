// 대한민국 공휴일 (대체공휴일·선거일 포함). 출처 = @hyunbinseo/holidays-kr (관보 기준, 연도별 lazy import).
// 임시공휴일 등 신규 지정은 패키지 업데이트 + 재배포로 반영. 공휴일 조회는 이 파일 한 곳만 통함.
import { getHolidayPreset } from "@hyunbinseo/holidays-kr";

export type HolidayMap = Record<string, readonly string[]>; // "YYYY-MM-DD" → 공휴일 이름들

export async function loadHolidays(years: number[]): Promise<HolidayMap> {
  const presets = await Promise.all(
    [...new Set(years)].map((yy) => getHolidayPreset(String(yy)).catch(() => ({}))) // 패키지 미수록 연도 = 공휴일 없음
  );
  return Object.assign({}, ...presets);
}

// 헤더용 짧은 이름: "대체공휴일(개천절)" → "대체공휴일"
export function shortHolidayName(names: readonly string[]): string {
  return names.map((n) => (n.startsWith("대체공휴일") ? "대체공휴일" : n)).join("·");
}
