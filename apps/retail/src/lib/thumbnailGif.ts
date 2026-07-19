// 썸네일(image_type='thumbnail') 이미지 여러 장 → 2초 간격 애니메이션 GIF 합성.
// 카페24 대표이미지 5MB 제한 대응: 1100x1300 → 800x945 → 600x709 순으로 자동 축소 재시도.
import sharp from "sharp";
import { GIFEncoder, quantize, applyPalette } from "gifenc";
import { getObjectBuffer, keyFromPublicUrl } from "./r2";

const MAX_BYTES = 4.5 * 1024 * 1024; // 5MB 한도 대비 여유
const CANDIDATE_SIZES: [number, number][] = [[1100, 1300], [800, 945], [600, 709]];
const DELAY_MS = 2000;
const MAX_FRAMES = 4;

export interface ThumbnailAsset {
  buffer: Buffer;
  ext: "gif" | "jpg";
  mime: string;
}

async function frameRaw(src: Buffer, w: number, h: number): Promise<Uint8Array> {
  const buf = await sharp(src)
    .resize(w, h, { fit: "cover", withoutEnlargement: true })
    .ensureAlpha()
    .raw()
    .toBuffer();
  return new Uint8Array(buf);
}

async function encodeGif(sources: Buffer[], w: number, h: number): Promise<Buffer> {
  const gif = GIFEncoder();
  for (const src of sources) {
    const data = await frameRaw(src, w, h);
    const palette = quantize(data, 256);
    const index = applyPalette(data, palette);
    gif.writeFrame(index, w, h, { palette, delay: DELAY_MS });
  }
  gif.finish();
  return Buffer.from(gif.bytes());
}

// urls: image_type='thumbnail' 이미지 URL (표시 순서). 1장 = 단일 JPEG, 2장+ = 애니메이션 GIF.
export async function buildThumbnailAsset(urls: string[]): Promise<ThumbnailAsset | null> {
  const keys = urls.slice(0, MAX_FRAMES)
    .map(u => keyFromPublicUrl(u))
    .filter((k): k is string => !!k);
  if (keys.length === 0) return null;

  const sources = await Promise.all(keys.map(k => getObjectBuffer(k)));

  if (sources.length === 1) {
    const [w, h] = CANDIDATE_SIZES[0];
    const buffer = await sharp(sources[0])
      .resize(w, h, { fit: "cover", withoutEnlargement: true })
      .jpeg({ quality: 88 })
      .toBuffer();
    return { buffer, ext: "jpg", mime: "image/jpeg" };
  }

  let last: Buffer | null = null;
  for (const [w, h] of CANDIDATE_SIZES) {
    const buffer = await encodeGif(sources, w, h);
    last = buffer;
    if (buffer.length <= MAX_BYTES) return { buffer, ext: "gif", mime: "image/gif" };
  }
  // 최소 사이즈로도 초과 — 그래도 5MB 카페24 한도 자체는 넘지 않을 가능성이 높은 최후 결과 반환
  return { buffer: last!, ext: "gif", mime: "image/gif" };
}
