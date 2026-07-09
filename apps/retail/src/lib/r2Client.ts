// 브라우저에서 R2 public URL → key 추출 (secret 없음, client 안전).
// NEXT_PUBLIC_R2_PUBLIC_BASE_URL prefix 매칭 대신 "/tenants/" 마커 기준 추출 —
// 커스텀 도메인이 바뀌어도(r2.dev 해시 변경 등) key 추출이 깨지지 않음.
export function keyFromR2Url(url: string): string | null {
  const marker = "/tenants/";
  const idx = url.indexOf(marker);
  if (idx === -1) return null;
  return url.slice(idx + 1);
}
