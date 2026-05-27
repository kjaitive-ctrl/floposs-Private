// ReceiptDoc → ESC/POS bytes 변환.
// Epson TM-T83III (80mm) 기준. 한글 인코딩 = CP949 (ESC t 13 / 페이지 21).
// TM-T 시리즈 표준 ESC/POS 호환이라 T20III/T82III 등으로 교체해도 동작.
//
// 주요 명령어:
//   ESC @         초기화
//   ESC a n       정렬 (0=L, 1=C, 2=R)
//   ESC E n       굵기 (0/1)
//   GS  ! n       문자 크기 (n = (width-1)<<4 | (height-1))
//   ESC d n       라인 피드 n줄
//   GS  V m       용지 절단 (m=0 전체, m=1 부분, m=66 부분+라인피드)
//   ESC t n       코드 페이지 (CP949 = 21)

import type { ReceiptDoc, ReceiptLine } from "./types";
import { encodeKr } from "./cp949";

const ESC = 0x1b;
const GS  = 0x1d;
const LF  = 0x0a;

function bytes(...arr: number[]): Uint8Array { return new Uint8Array(arr); }

function init(): Uint8Array {
  return new Uint8Array([
    ESC, 0x40,            // initialize
    ESC, 0x74, 21,         // codepage CP949 (Korea)
  ]);
}

function align(a: "left" | "center" | "right"): Uint8Array {
  const n = a === "center" ? 1 : a === "right" ? 2 : 0;
  return bytes(ESC, 0x61, n);
}

function bold(on: boolean): Uint8Array {
  return bytes(ESC, 0x45, on ? 1 : 0);
}

function size(s: 1 | 2 | 3): Uint8Array {
  // GS ! n — width/height 배율 (1~8). size=1=기본, size=2=2배, size=3=3배.
  const v = s - 1;
  const n = (v << 4) | v;
  return bytes(GS, 0x21, n);
}

function feed(n = 1): Uint8Array {
  return bytes(ESC, 0x64, n);
}

function cut(): Uint8Array {
  // 마지막에 약간의 라인피드 후 절단 (자동 절단 지원 모델)
  return bytes(GS, 0x56, 66, 0);
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}

// ── 텍스트 레이아웃 helpers ───────────────────────────
// 한글 1글자 = 너비 2, ASCII 1글자 = 너비 1 (영수증 프린터 표준)
function visualWidth(s: string): number {
  let w = 0;
  for (const ch of s) {
    const code = ch.codePointAt(0)!;
    // 한글, CJK 등 폭 2
    w += (code > 0x7f) ? 2 : 1;
  }
  return w;
}

function padRight(s: string, width: number): string {
  const w = visualWidth(s);
  return w >= width ? s : s + " ".repeat(width - w);
}

function padLeft(s: string, width: number): string {
  const w = visualWidth(s);
  return w >= width ? s : " ".repeat(width - w) + s;
}

// ── 줄 빌더 ────────────────────────────────────────
function lineBytes(line: ReceiptLine, charsPerLine: number): Uint8Array {
  switch (line.kind) {
    case "text": {
      const a = align(line.align ?? "left");
      const b = bold(!!line.bold);
      const z = size(line.size ?? 1);
      const text = encodeKr(line.text);
      const reset = concat(bold(false), size(1), align("left"));
      return concat(a, b, z, text, bytes(LF), reset);
    }
    case "kv": {
      const w = charsPerLine;
      const right = padLeft(line.right, w - visualWidth(line.left));
      const text = encodeKr(line.left + right);
      const b = bold(!!line.bold);
      return concat(align("left"), b, text, bytes(LF), bold(false));
    }
    case "row3": {
      const w = charsPerLine;
      // 좌 + 가운데(폭 8) + 우. 가운데는 중앙 정렬 + 우측과 최소 공백 1칸 강제 (붙음 방지).
      const middleW = 8;
      const middleVw = visualWidth(line.middle);
      const padL = Math.max(0, Math.floor((middleW - middleVw) / 2));
      const padR = Math.max(1, middleW - middleVw - padL);
      const middle = " ".repeat(padL) + line.middle + " ".repeat(padR);
      const middleActualW = visualWidth(middle);
      const leftW = w - middleActualW - visualWidth(line.right);
      const left  = padRight(line.left, Math.max(0, leftW));
      const b = bold(!!line.bold);
      const z = size(line.size ?? 1);
      const text = encodeKr(left + middle + line.right);
      const reset = concat(bold(false), size(1));
      return concat(align("left"), b, z, text, bytes(LF), reset);
    }
    case "rule": {
      // 박스 그리기 글자로 진짜 한 줄짜리 선. CP949 (KS X 1001) 영역, Epson 호환.
      // U+2500 ─ (light) 만 cp949 매핑 안전. U+2550 ═ (double) 는 iconv-lite cp949 테이블 누락 → ASCII '=' 그대로 사용 (시각상 굵음 효과 보존).
      const charMap: Record<string, string> = { "-": "─", "·": "·", "_": "_" };
      const inputCh = line.char ?? "-";
      const ch = charMap[inputCh] ?? inputCh;
      const cw = visualWidth(ch);
      const count = Math.max(1, Math.floor(charsPerLine / cw));
      const text = encodeKr(ch.repeat(count));
      return concat(align("left"), text, bytes(LF));
    }
    case "barcode": {
      // Code128 바코드 + HRI (Human Readable Interpretation 아래 표시).
      // GS H n   HRI 위치 (0=off, 1=above, 2=below, 3=both)
      // GS h n   바코드 높이 (dots, 1~255). 80 정도.
      // GS w n   모듈 너비 (2~6). 2 정도.
      // GS k m d1...dn NUL  바코드 데이터 (m=73 = Code128)
      const data = line.value;
      const dataBytes = new TextEncoder().encode(data);
      const hriPos = (line.hri ?? true) ? 2 : 0;  // 아래 표시
      const cmd = new Uint8Array([
        GS, 0x48, hriPos,           // HRI position
        GS, 0x68, 80,               // height = 80 dots
        GS, 0x77, 2,                // width module = 2
        GS, 0x6b, 73, dataBytes.length,
        ...dataBytes,
      ]);
      return concat(align("center"), cmd, bytes(LF));
    }
    case "blank":
      return bytes(LF);
    case "cut":
      return concat(feed(2), cut());
  }
}

export function toEscPos(doc: ReceiptDoc): Uint8Array {
  const parts: Uint8Array[] = [init()];
  for (const line of doc.lines) {
    parts.push(lineBytes(line, doc.charsPerLine));
  }
  return concat(...parts);
}
