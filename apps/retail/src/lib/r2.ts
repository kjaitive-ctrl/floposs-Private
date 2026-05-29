// Cloudflare R2 (S3 호환) — 서버 전용. Secret 키 사용하므로 client bundle 으로 새 나가면 안 됨.
// route handler 에서만 import. (NEXT_PUBLIC_R2_PUBLIC_BASE_URL 만 client 안전.)
//
// 사용처:
//   - /api/r2/sign : presigned PUT URL 발급 (브라우저 → R2 직접 PUT)
//   - /api/r2/delete : 객체 삭제
//
// key prefix 규칙: tenants/{tenant_id}/products/{product_id}/{uuid}.{ext}
//   - tenant_id 가 prefix 의 1단 → 인증 검증 후 sign/delete 모두 prefix 일치 강제.
//   - 다른 tenant 의 key 위조 차단.

import { S3Client, PutObjectCommand, DeleteObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { randomUUID } from "crypto";

const R2_BUCKET = process.env.R2_BUCKET!;
const R2_PUBLIC_BASE_URL = process.env.NEXT_PUBLIC_R2_PUBLIC_BASE_URL!;

// S3Client 싱글톤. region 은 R2 에서 의미 없지만 SDK 가 요구 → "auto".
const s3 = new S3Client({
  region: "auto",
  endpoint: process.env.R2_S3_ENDPOINT!,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID!,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
  },
});

// 안전한 확장자만 통과. 그 외 .bin 으로 변환.
const ALLOWED_EXT = new Set(["jpg", "jpeg", "png", "webp", "gif", "avif"]);

export function extFromMime(mime: string): string {
  const m = mime.toLowerCase();
  if (m === "image/jpeg" || m === "image/jpg") return "jpg";
  if (m === "image/png") return "png";
  if (m === "image/webp") return "webp";
  if (m === "image/gif") return "gif";
  if (m === "image/avif") return "avif";
  return "bin";
}

export function buildImageKey(tenantId: string, productId: string, mime: string): string {
  const ext = extFromMime(mime);
  const safeExt = ALLOWED_EXT.has(ext) ? ext : "bin";
  return `tenants/${tenantId}/products/${productId}/${randomUUID()}.${safeExt}`;
}

// presigned PUT URL — 브라우저가 이 URL 로 직접 PUT (Vercel 우회).
// 5분 만료 (충분히 길어야 큰 파일 업로드 가능, 너무 길면 보안 X).
export async function getPresignedPutUrl(key: string, contentType: string): Promise<string> {
  const cmd = new PutObjectCommand({
    Bucket: R2_BUCKET,
    Key: key,
    ContentType: contentType,
  });
  return getSignedUrl(s3, cmd, { expiresIn: 300 });
}

// presigned GET URL — 다운로드용. 핵심:
//   - S3 endpoint 라 bucket CORS 정책 적용됨 (r2.dev public URL 의 CORS quirk 우회)
//   - ResponseContentDisposition=attachment 로 브라우저가 자동 다운로드 (탭 열림 X)
//   - filename* RFC 5987 인코딩으로 한글 파일명도 안전
export async function getPresignedGetUrl(key: string, filename?: string): Promise<string> {
  const cmd = new GetObjectCommand({
    Bucket: R2_BUCKET,
    Key: key,
    ResponseContentDisposition: filename
      ? `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`
      : `attachment`,
  });
  return getSignedUrl(s3, cmd, { expiresIn: 300 });
}

// 객체 삭제. key 가 본인 tenant prefix 인지 호출자가 검증해야 함.
export async function deleteObject(key: string): Promise<void> {
  await s3.send(new DeleteObjectCommand({ Bucket: R2_BUCKET, Key: key }));
}

// public read URL 조립. CDN domain (r2.dev) + key.
export function publicUrlForKey(key: string): string {
  return `${R2_PUBLIC_BASE_URL}/${key}`;
}

// 공개 URL 에서 key 역추출 (삭제 시 url 만 박혀있을 때).
// null 반환 = 우리 R2 가 아닌 외부 URL (cleanup 대상 X).
export function keyFromPublicUrl(url: string): string | null {
  const prefix = `${R2_PUBLIC_BASE_URL}/`;
  if (!url.startsWith(prefix)) return null;
  return url.slice(prefix.length);
}

// tenant prefix 검증 — sign/delete 에서 tampering 차단.
export function isKeyOwnedByTenant(key: string, tenantId: string): boolean {
  return key.startsWith(`tenants/${tenantId}/`);
}
