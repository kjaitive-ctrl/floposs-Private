"use client";

// 영수증 출력 진입점 — printReceipt(orderId) 한 함수로 모든 단계 실행.
//
// 흐름:
//   1. 서버 API 호출 → ESC/POS bytes(base64) + 미리보기 doc 받기
//   2. QZ Tray 연결 + 기본 프린터 선택
//   3. 프린터로 raw bytes 전송
//
// 호출자는 이 함수 한 줄만 부르면 됨. 버튼/UI 위치는 호출자 자유.

import { supabase } from "@/lib/supabase";
import { ensureQzConnected, getDefaultPrinter, printRawBase64 } from "./printerTransport";
import type { ReceiptDoc } from "./types";

export type PrintResult =
  | { ok: true;  printer: string }
  | { ok: false; error: string };

export async function fetchReceiptBytes(orderId: string): Promise<{ bytes: string; doc: ReceiptDoc } | null> {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) return null;
  const res = await fetch(`/api/receipt/${orderId}/print`, {
    headers: { Authorization: `Bearer ${session.access_token}` },
  });
  if (!res.ok) return null;
  return res.json();
}

export async function printReceipt(orderId: string): Promise<PrintResult> {
  const fetched = await fetchReceiptBytes(orderId);
  if (!fetched) return { ok: false, error: "영수증 데이터 조회 실패" };
  try {
    await ensureQzConnected();
  } catch (e) {
    return { ok: false, error: `QZ Tray 연결 실패: ${(e as Error).message}\n\nQZ Tray 데스크탑 앱이 실행 중인지 확인하세요.` };
  }
  let printer: string;
  try {
    printer = await getDefaultPrinter();
  } catch (e) {
    return { ok: false, error: `기본 프린터 조회 실패: ${(e as Error).message}` };
  }
  try {
    await printRawBase64(printer, fetched.bytes);
    return { ok: true, printer };
  } catch (e) {
    return { ok: false, error: `프린터 전송 실패: ${(e as Error).message}` };
  }
}

// 호출자 편의: doc 미리 받아서 미리보기 띄울 때
export { fetchReceiptBytes as fetchReceiptDoc };
export type { ReceiptDoc } from "./types";
export { ReceiptPreview } from "./ReceiptPreview";
