"use client";

// QZ Tray 통신 레이어 — 브라우저 ↔ 로컬 프린터.
//
// 동작:
//   1. QZ Tray 데스크탑 앱이 사용자 PC 에 실행 중이어야 함 (포트 8181/8182 WebSocket).
//   2. qz.websocket.connect() 로 연결.
//   3. qz.printers.find() / .getDefault() 로 프린터 선택.
//   4. qz.print(config, [{ type: 'raw', format: 'base64', data: bytes }]) 로 ESC/POS 전송.
//
// 운영 시 코드 서명 인증서 필요 (현재는 개발용, 자체 서명).

// qz-tray 는 client-only. 동적 import 로 SSR 회피.
type QzModule = {
  websocket: {
    isActive(): boolean;
    connect(opts?: { retries?: number; delay?: number }): Promise<void>;
    disconnect(): Promise<void>;
  };
  printers: {
    find(): Promise<string[]>;
    getDefault(): Promise<string>;
  };
  configs: { create(printer: string, opts?: Record<string, unknown>): unknown };
  print(config: unknown, data: unknown[]): Promise<void>;
  security: {
    setCertificatePromise(fn: (resolve: (cert: string) => void, reject: (err: unknown) => void) => void): void;
    setSignaturePromise(fn: (toSign: string) => (resolve: (sig: string) => void, reject: (err: unknown) => void) => void): void;
    setSignatureAlgorithm(algo: string): void;
  };
};

let qzInstance: QzModule | null = null;
let securityRegistered = false;

async function getQz(): Promise<QzModule> {
  if (qzInstance) return qzInstance;
  const mod = await import("qz-tray");
  // qz-tray는 default export (UMD). 타입 단언으로 처리.
  const qz = ((mod as { default?: QzModule }).default ?? (mod as unknown as QzModule));
  qzInstance = qz;
  return qz;
}

// 자체 서명 인증서 + private key 로 모든 요청 서명 → QZ Tray "Untrusted website" 팝업 우회.
// 사장 PC 의 QZ Tray 폴더에 override.crt (= digital-certificate.pem) 가 설치돼 있어야 자동 신뢰됨.
function registerSecurity(qz: QzModule): void {
  if (securityRegistered) return;
  securityRegistered = true;
  // qz-tray 2.x default = SHA1. 서버 측 RSA-SHA512 서명과 정합 위해 명시.
  qz.security.setSignatureAlgorithm("SHA512");
  qz.security.setCertificatePromise((resolve, reject) => {
    fetch("/api/qz/cert")
      .then((r) => (r.ok ? r.text() : Promise.reject(new Error(`cert HTTP ${r.status}`))))
      .then(resolve)
      .catch(reject);
  });
  qz.security.setSignaturePromise((toSign) => (resolve, reject) => {
    fetch("/api/qz/sign", {
      method: "POST",
      body: toSign,
      headers: { "Content-Type": "text/plain" },
    })
      .then((r) => (r.ok ? r.text() : Promise.reject(new Error(`sign HTTP ${r.status}`))))
      .then(resolve)
      .catch(reject);
  });
}

export async function ensureQzConnected(): Promise<void> {
  const qz = await getQz();
  registerSecurity(qz);
  if (qz.websocket.isActive()) return;
  await qz.websocket.connect({ retries: 2, delay: 1 });
}

export async function listPrinters(): Promise<string[]> {
  await ensureQzConnected();
  const qz = await getQz();
  return qz.printers.find();
}

export async function getDefaultPrinter(): Promise<string> {
  await ensureQzConnected();
  const qz = await getQz();
  return qz.printers.getDefault();
}

// 선택된 프린터로 ESC/POS bytes(base64) 전송.
export async function printRawBase64(printerName: string, base64: string): Promise<void> {
  await ensureQzConnected();
  const qz = await getQz();
  const config = qz.configs.create(printerName, { encoding: "EUC-KR" });
  await qz.print(config, [
    { type: "raw", format: "base64", data: base64 },
  ]);
}
