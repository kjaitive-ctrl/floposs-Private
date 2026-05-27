// 숫자 포맷 공통 유틸 — 프로젝트 전체에서 같은 표기.

// 1234 / "1234" / "01,234" → "1,234". null/빈값/잘못된 입력 → "".
export function formatComma(v: string | number | null | undefined): string {
  if (v === null || v === undefined || v === "") return "";
  const cleaned = String(v).replace(/[^0-9]/g, "");
  if (cleaned === "") return "";
  const n = Number(cleaned);
  return isNaN(n) ? "" : n.toLocaleString();
}

// 사용자 입력 정리 — 숫자만 추출 + 앞 0 제거 ("01,000" → "1000"). 빈값 → "".
export function parseDigits(v: string): string {
  const cleaned = v.replace(/[^0-9]/g, "");
  if (cleaned === "") return "";
  return String(Number(cleaned)); // "01000" → 1000 → "1000"
}

// ─── 짧은 날짜 표기 ──────────────────────────────────
// DB 박제는 ISO "2026-06-03". UI 표시는 "26-06-03".

// "2026-06-03" → "26-06-03". 빈/잘못된 입력 → "".
export function formatShortDate(iso: string | null | undefined): string {
  if (!iso || iso.length !== 10) return "";
  return iso.slice(2); // "26-06-03"
}

// 사용자 입력을 ISO 형식 ("2026-06-03") 으로 파싱.
// 지원 형식:
//   "5-21" / "5/21" / "05.21" / "0521"   → 현재 KST 연도 사용 → "2026-05-21"
//   "26-5-21" / "26-05-21" / "260521"     → "2026-05-21"
//   불완전/잘못된 입력                       → "" (박제 X)
export function parseShortDate(s: string): string {
  if (!s.trim()) return "";

  // 구분자 분리 (-, /, .)
  const parts = s.split(/[\-/.]/).map(p => p.replace(/\D/g, "")).filter(Boolean);

  const kstYear = () =>
    new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Seoul" }).slice(2, 4);

  let yy = "", mm = "", dd = "";

  if (parts.length === 3) {
    [yy, mm, dd] = parts;
  } else if (parts.length === 2) {
    // 월-일만 입력 → 올해 연도 자동 보완
    yy = kstYear();
    [mm, dd] = parts;
  } else if (parts.length === 1) {
    const d = parts[0];
    if (d.length === 6)      { yy = d.slice(0, 2); mm = d.slice(2, 4); dd = d.slice(4, 6); }
    else if (d.length === 4) { yy = kstYear();     mm = d.slice(0, 2); dd = d.slice(2, 4); }
    else return "";
  } else {
    return "";
  }

  if (!yy || !mm || !dd) return "";
  yy = yy.padStart(2, "0");
  mm = mm.padStart(2, "0");
  dd = dd.padStart(2, "0");
  if (yy.length !== 2 || mm.length > 2 || dd.length > 2) return "";

  const mn = Number(mm);
  const dn = Number(dd);
  if (mn < 1 || mn > 12 || dn < 1 || dn > 31) return "";

  return `20${yy}-${mm}-${dd}`;
}
