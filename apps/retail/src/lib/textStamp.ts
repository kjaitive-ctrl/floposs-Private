// 상품컷 상단 중앙에 색상 라벨 텍스트(예: "아이보리(ivory)")를 합성 — R2 원본을 덮어쓰기 전 이 buffer 생성.
// 텍스트는 SVG <text> 로 그려서 @resvg/resvg-js 로 래스터라이즈:
//   sharp 의 SVG composite 는 서버 fontconfig 에 폰트가 없으면 조용히 기본 폰트로 깨짐(배포 환경별로 결과 달라짐).
//   resvg 는 폰트 파일을 직접 주입받아 렌더링하므로 로컬/배포 어디서든 항상 Pretendard 로 동일하게 나옴.
import { Resvg } from "@resvg/resvg-js";
import sharp from "sharp";
import fs from "fs";
import path from "path";

const FONT_PATH = path.join(process.cwd(), "src/assets/fonts/Pretendard-Bold.otf");
const TOP_MARGIN_PX = 10;

let fontPathVerified = false;
function verifyFontPath(): string {
  if (!fontPathVerified) {
    if (!fs.existsSync(FONT_PATH)) {
      throw new Error(`폰트 파일 없음: ${FONT_PATH}`);
    }
    fontPathVerified = true;
  }
  return FONT_PATH;
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function buildLabelSvg(text: string, width: number, height: number, fontSize: number): string {
  const strokeWidth = Math.max(2, Math.round(fontSize * 0.06));
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
  <text x="50%" y="${TOP_MARGIN_PX}" text-anchor="middle" dominant-baseline="hanging"
    font-family="Pretendard" font-weight="700" font-size="${fontSize}"
    fill="#ffffff" stroke="#000000" stroke-width="${strokeWidth}" paint-order="stroke">${escapeXml(text)}</text>
</svg>`;
}

// mime 별 안전한 인코더 선택. 미지원 포맷(gif 등)은 png 로 폴백 (sharp 가 애니메이션/정지 gif 인코딩을 지원하지 않음).
function encodeFor(pipeline: sharp.Sharp, mime: string): sharp.Sharp {
  const m = mime.toLowerCase();
  if (m === "image/png") return pipeline.png();
  if (m === "image/webp") return pipeline.webp();
  if (m === "image/jpeg" || m === "image/jpg") return pipeline.jpeg({ quality: 90 });
  return pipeline.png();
}

// 원본 이미지 buffer + 라벨 텍스트 → 각인된 이미지 buffer.
export async function stampImageBuffer(src: Buffer, mime: string, text: string): Promise<Buffer> {
  const fontPath = verifyFontPath();
  const meta = await sharp(src).metadata();
  const width = meta.width ?? 1000;
  const height = meta.height ?? 1000;
  const fontSize = Math.min(72, Math.max(20, Math.round(width * 0.045)));

  const svg = buildLabelSvg(text, width, height, fontSize);
  const resvg = new Resvg(svg, {
    font: { fontFiles: [fontPath], loadSystemFonts: false, defaultFontFamily: "Pretendard" },
    background: "rgba(0,0,0,0)",
  });
  const labelPng = resvg.render().asPng();

  const pipeline = sharp(src).composite([{ input: labelPng, top: 0, left: 0 }]);
  return encodeFor(pipeline, mime).toBuffer();
}
