import { NextResponse } from "next/server";
import { getDigitalCertificate } from "@/lib/qz/keys";

// QZ Tray 가 setCertificatePromise 등록 시 호출.
// 공개 인증서만 반환 (private key 절대 X).
export async function GET() {
  return new NextResponse(getDigitalCertificate(), {
    status: 200,
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}
