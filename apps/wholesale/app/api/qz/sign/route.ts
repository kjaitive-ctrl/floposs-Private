import { NextResponse } from "next/server";
import { createSign } from "node:crypto";
import { getPrivateKey } from "@/lib/qz/keys";

// QZ Tray 가 setSignaturePromise 등록 시 호출.
// QZ 가 전송한 toSign 문자열을 SHA512 + RSA 로 서명, base64 반환.
// 알고리즘: qz-tray 2.x default = SHA512withRSA.
export async function POST(req: Request) {
  const toSign = await req.text();
  if (!toSign) {
    return new NextResponse("missing payload", { status: 400 });
  }
  const signer = createSign("RSA-SHA512");
  signer.update(toSign);
  signer.end();
  const signature = signer.sign(getPrivateKey(), "base64");
  return new NextResponse(signature, {
    status: 200,
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}
