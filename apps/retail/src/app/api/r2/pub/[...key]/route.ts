// GET /api/r2/pub/[...key]
// R2 이미지를 Vercel 서버를 통해 서빙. 카페24 등 외부 서비스가 r2.dev URL에 접근 못할 때 사용.
// 카페24 상품 등록 시 이미지 URL로 이 경로를 사용 → 등록 후엔 카페24 CDN에서 서빙되므로 Vercel 부하 없음.
import { NextRequest, NextResponse } from "next/server";
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";

const s3 = new S3Client({
  region: "auto",
  endpoint: process.env.R2_S3_ENDPOINT!,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID!,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
  },
});

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ key: string[] }> },
) {
  const { key } = await params;
  const keyStr = key.join("/");

  try {
    const res = await s3.send(
      new GetObjectCommand({ Bucket: process.env.R2_BUCKET!, Key: keyStr }),
    );
    const body = await res.Body?.transformToByteArray();
    if (!body) return new NextResponse(null, { status: 404 });

    return new NextResponse(Buffer.from(body), {
      headers: {
        "Content-Type": res.ContentType ?? "image/jpeg",
        "Cache-Control": "public, max-age=31536000, immutable",
      },
    });
  } catch {
    return new NextResponse(null, { status: 404 });
  }
}
