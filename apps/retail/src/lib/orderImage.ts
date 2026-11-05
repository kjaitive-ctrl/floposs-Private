// 주문 시트 거래처별 이미지 — 카톡으로 거래처에 보내는 발주서. 화면 캡처 대신 canvas 에 직접 그려
// 글자가 선명하고 외부 라이브러리가 필요 없음. 거래처에 나가는 이미지라 단가·소계는 넣지 않음.

export type OrderImageRow = {
  name: string;
  option: string;
  size: string;
  supplier: string;
  quantity: number;
};

const FONT_FAMILY = `"Malgun Gothic", "맑은 고딕", Pretendard, "Apple SD Gothic Neo", sans-serif`;
const SCALE = 2;  // 카톡에서 확대해도 흐리지 않게 2배로 그림
const ROW_H = 30;
const TITLE_H = 46;
const CELL_PAD = 14;
const LINE = "#BDBDBD";

const COLUMNS: {
  label: string;
  minWidth: number;
  align: CanvasTextAlign;
  value: (r: OrderImageRow) => string;
}[] = [
  { label: "사입상품명", minWidth: 150, align: "left", value: r => r.name },
  { label: "사입옵션", minWidth: 90, align: "center", value: r => r.option },
  { label: "사이즈", minWidth: 70, align: "center", value: r => r.size },
  { label: "거래처", minWidth: 90, align: "center", value: r => r.supplier },
  { label: "발주량", minWidth: 70, align: "right", value: r => r.quantity.toLocaleString() },
];

export function renderOrderImage(title: string, subtitle: string, rows: OrderImageRow[]): Promise<Blob> {
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  if (!ctx) return Promise.reject(new Error("이미지를 만들 수 없는 브라우저입니다."));

  const titleFont = `bold 19px ${FONT_FAMILY}`;
  const subtitleFont = `bold 13px ${FONT_FAMILY}`;
  const cellFont = `bold 13px ${FONT_FAMILY}`;

  // 긴 상품명이 잘리지 않도록 내용에 맞춰 칸 너비 결정
  ctx.font = cellFont;
  const widths = COLUMNS.map(col => Math.ceil(Math.max(
    col.minWidth,
    ctx.measureText(col.label).width + CELL_PAD * 2,
    ...rows.map(r => ctx.measureText(col.value(r)).width + CELL_PAD * 2),
  )));
  ctx.font = titleFont;
  const titleWidth = ctx.measureText(title).width;
  ctx.font = subtitleFont;
  const headerWidth = titleWidth + ctx.measureText(subtitle).width + 8 + CELL_PAD * 2;
  const tableWidth = widths.reduce((sum, w) => sum + w, 0);
  // 제목이 표보다 길면 첫 칸(상품명)을 늘림
  if (headerWidth > tableWidth) widths[0] += Math.ceil(headerWidth - tableWidth);
  const width = Math.max(tableWidth, Math.ceil(headerWidth));
  const height = TITLE_H + ROW_H * (rows.length + 1);

  canvas.width = (width + 1) * SCALE;
  canvas.height = (height + 1) * SCALE;
  ctx.scale(SCALE, SCALE);
  ctx.fillStyle = "#FFFFFF";
  ctx.fillRect(0, 0, width + 1, height + 1);
  ctx.textBaseline = "middle";

  // 제목
  ctx.fillStyle = "#000000";
  ctx.textAlign = "left";
  ctx.font = titleFont;
  ctx.fillText(title, CELL_PAD, TITLE_H / 2);
  ctx.font = subtitleFont;
  ctx.fillText(subtitle, CELL_PAD + titleWidth + 8, TITLE_H / 2 + 1);

  // 머리글 배경
  ctx.fillStyle = "#BFBFBF";
  ctx.fillRect(0, TITLE_H, width, ROW_H);

  // 머리글 + 행
  ctx.font = cellFont;
  ctx.fillStyle = "#000000";
  let x = 0;
  COLUMNS.forEach((col, i) => {
    ctx.textAlign = "center";
    ctx.fillText(col.label, x + widths[i] / 2, TITLE_H + ROW_H / 2 + 1);
    ctx.textAlign = col.align;
    const textX = col.align === "left" ? x + CELL_PAD
      : col.align === "right" ? x + widths[i] - CELL_PAD
      : x + widths[i] / 2;
    rows.forEach((row, r) => {
      ctx.fillText(col.value(row), textX, TITLE_H + ROW_H * (r + 1) + ROW_H / 2 + 1);
    });
    x += widths[i];
  });

  // 격자 (0.5 보정으로 선이 번지지 않게)
  ctx.strokeStyle = LINE;
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let r = 0; r <= rows.length + 1; r++) {
    const y = TITLE_H + ROW_H * r + 0.5;
    ctx.moveTo(0, y);
    ctx.lineTo(width, y);
  }
  let lineX = 0;
  ctx.moveTo(0.5, TITLE_H);
  ctx.lineTo(0.5, height);
  for (const w of widths) {
    lineX += w;
    ctx.moveTo(lineX + 0.5, TITLE_H);
    ctx.lineTo(lineX + 0.5, height);
  }
  ctx.stroke();

  return new Promise((resolve, reject) => {
    canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error("이미지를 만들지 못했습니다.")), "image/png");
  });
}

export type CopyResult = "copied" | "downloaded";

// 클립보드에 이미지 복사. 브라우저가 막으면 파일로 내려받음.
// ClipboardItem 에 Promise 를 그대로 넘겨야 Safari 에서도 클릭 직후 동작으로 인정됨.
export async function copyOrderImage(image: Promise<Blob>, filename: string): Promise<CopyResult> {
  try {
    await navigator.clipboard.write([new ClipboardItem({ "image/png": image })]);
    return "copied";
  } catch {
    const url = URL.createObjectURL(await image);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    return "downloaded";
  }
}
