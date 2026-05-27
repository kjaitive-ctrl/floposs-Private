import "server-only";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// QZ Tray 자체 서명 인증서/키 로더.
// 로컬: .qz-cert/ 파일 읽기 (gitignore 보호).
// Vercel: 같은 변수 env (QZ_DIGITAL_CERTIFICATE, QZ_PRIVATE_KEY) 박기 — 파일 fallback.
//
// PEM 멀티라인 env 박는 법 (Vercel UI):
//   - Settings → Environment Variables → Add
//   - Value 필드에 -----BEGIN...----- 부터 -----END...----- 까지 줄바꿈 포함 그대로 붙여넣기

const CERT_DIR = join(process.cwd(), ".qz-cert");

let cachedCert: string | null = null;
let cachedKey: string | null = null;

export function getDigitalCertificate(): string {
  if (cachedCert) return cachedCert;
  const fromEnv = process.env.QZ_DIGITAL_CERTIFICATE;
  if (fromEnv) {
    cachedCert = fromEnv.replace(/\\n/g, "\n");
    return cachedCert;
  }
  cachedCert = readFileSync(join(CERT_DIR, "digital-certificate.pem"), "utf-8");
  return cachedCert;
}

export function getPrivateKey(): string {
  if (cachedKey) return cachedKey;
  const fromEnv = process.env.QZ_PRIVATE_KEY;
  if (fromEnv) {
    cachedKey = fromEnv.replace(/\\n/g, "\n");
    return cachedKey;
  }
  cachedKey = readFileSync(join(CERT_DIR, "private-key.pem"), "utf-8");
  return cachedKey;
}
