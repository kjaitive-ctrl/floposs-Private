// 스타일링 후보 샘플 사진 업로드 (마이그 244).
// 캡처 PNG(1~3MB)를 브라우저에서 WebP·긴 변 1200px 로 줄인 뒤 R2 에 직접 PUT.
//   1) /api/r2/sign (kind='styling', cell_id) → presigned PUT URL
//   2) 브라우저 → R2 직접 업로드 (Vercel 우회)
//   3) 호출자가 styling_cells.image_key/image_url 저장, 옛 사진은 deleteR2Key 로 삭제

const MAX_SIDE = 1200;

export async function compressImage(file: Blob): Promise<Blob> {
  try {
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, MAX_SIDE / Math.max(bmp.width, bmp.height));
    const w = Math.round(bmp.width * scale), h = Math.round(bmp.height * scale);
    const canvas = document.createElement("canvas");
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) return file;
    ctx.drawImage(bmp, 0, 0, w, h);
    bmp.close();
    const out = await new Promise<Blob | null>(res => canvas.toBlob(res, "image/webp", 0.85));
    return out && out.size > 0 ? out : file;
  } catch {
    return file; // 변환 실패 시 원본 그대로
  }
}

export async function uploadStylingImage(cellId: string, file: Blob): Promise<{ key: string; url: string }> {
  const blob = await compressImage(file);
  const mime = blob.type || "image/png";
  const signRes = await fetch("/api/r2/sign", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ kind: "styling", cell_id: cellId, mime, file_size: blob.size }),
  });
  const sign = await signRes.json();
  if (!signRes.ok) throw new Error(sign.error || `업로드 준비 실패 (${signRes.status})`);
  const put = await fetch(sign.upload_url, { method: "PUT", headers: { "Content-Type": mime }, body: blob });
  if (!put.ok) throw new Error(`업로드 실패 (${put.status})`);
  return { key: sign.key, url: sign.public_url };
}

export async function deleteR2Key(key: string): Promise<void> {
  try {
    await fetch("/api/r2/delete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key }),
    });
  } catch { /* 지우기 실패 = 안 보이는 파일만 남음 (화면엔 영향 없음) */ }
}

// 붙여넣기/끌어놓기 이벤트에서 이미지 파일 꺼내기
export function imageFromDataTransfer(dt: DataTransfer | null): File | null {
  if (!dt) return null;
  for (const it of Array.from(dt.items ?? [])) {
    if (it.kind === "file" && it.type.startsWith("image/")) return it.getAsFile();
  }
  for (const f of Array.from(dt.files ?? [])) {
    if (f.type.startsWith("image/")) return f;
  }
  return null;
}
