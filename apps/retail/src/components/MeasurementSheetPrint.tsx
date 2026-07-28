"use client";

// 샘플 사이즈/누끼 체크표 — A4 가로 인쇄 전용 (화면엔 안 보이고 인쇄 시에만 노출).
// 물리 샘플을 자로 재며 손으로 적는 용도라 PDF 다운로드 대신 브라우저 인쇄
// (다른 프린터로 "PDF로 저장" 선택 가능) 사용. 바탕화면 "샘플 사이즈 누끼 체크 표.xlsx"
// 양식과 동일한 컬럼 구성. globals.css 의 @media print 규칙과 짝.
const COLUMNS = [
  "상품명", "누끼", "어깨/허리", "가슴/힙", "소매/허벅지",
  "암홀/밑위", "팔통 단면", "소매 단면", "밑단", "총장",
] as const;

export default function MeasurementSheetPrint({ names }: { names: string[] }) {
  if (names.length === 0) return null;
  return (
    <div className="measurement-sheet-print hidden">
      <table className="w-full border-collapse">
        <thead>
          <tr>
            {COLUMNS.map((c) => (
              <th key={c} className="border border-black text-xs font-bold py-2 px-1 whitespace-nowrap">{c}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {names.map((name, i) => (
            <tr key={i} style={{ breakInside: "avoid" }}>
              <td className="border border-black text-xs px-2 py-1 font-medium">{name}</td>
              {COLUMNS.slice(1).map((c) => (
                <td key={c} className="border border-black" style={{ height: "13mm" }} />
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
