"use client";

// 영수증 미리보기 + 출력 + 카톡(이미지) 복사 모달.
// orderId 받아서 서버 API 호출 → 미리보기 표시 → [출력] / [카톡 복사].

import { useEffect, useRef, useState } from "react";
import Modal from "../Modal";
import { ReceiptPreview } from "./ReceiptPreview";
import { fetchReceiptBytes } from "./index";
import { ensureQzConnected, getDefaultPrinter, printRawBase64 } from "./printerTransport";
import type { ReceiptDoc } from "./types";

type Props = {
  orderId: string;
  onClose: () => void;
  onPrinted?: () => void;
};

export function ReceiptPrintModal({ orderId, onClose, onPrinted }: Props) {
  const [doc, setDoc] = useState<ReceiptDoc | null>(null);
  const [bytes, setBytes] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [printError, setPrintError] = useState<string | null>(null);
  const [printing, setPrinting] = useState(false);
  const [printed, setPrinted] = useState(false);
  const [copying, setCopying] = useState(false);
  const [copyMsg, setCopyMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const previewRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const r = await fetchReceiptBytes(orderId);
      if (cancelled) return;
      if (!r) { setLoadError("영수증 데이터 조회 실패"); return; }
      setDoc(r.doc);
      setBytes(r.bytes);
    })();
    return () => { cancelled = true; };
  }, [orderId]);

  async function handlePrint() {
    if (!bytes) return;
    setPrinting(true);
    setPrintError(null);
    try {
      await ensureQzConnected();
    } catch (e) {
      setPrintError(`QZ Tray 연결 실패: ${(e as Error).message}\nQZ Tray 데스크탑 앱이 실행 중인지 확인하세요.`);
      setPrinting(false);
      return;
    }
    let printer: string;
    try {
      printer = await getDefaultPrinter();
    } catch (e) {
      setPrintError(`기본 프린터 조회 실패: ${(e as Error).message}`);
      setPrinting(false);
      return;
    }
    try {
      await printRawBase64(printer, bytes);
      setPrinted(true);
      onPrinted?.();
    } catch (e) {
      setPrintError(`프린터 전송 실패: ${(e as Error).message}`);
    } finally {
      setPrinting(false);
    }
  }

  async function handleCopyImage() {
    if (!previewRef.current) return;
    const content = previewRef.current.querySelector("[data-receipt-content]") as HTMLElement | null;
    if (!content) return;
    setCopying(true);
    setCopyMsg(null);
    try {
      // ClipboardItem 의 lazy Promise — toBlob 비동기 동안 사용자 제스처 컨텍스트 유지
      // 캡처 시 style 옵션으로 transform 무효화 + 명시 width/height 로 전체 보장.
      const blobPromise = (async () => {
        const { toBlob } = await import("html-to-image");
        const w = content.offsetWidth;
        const h = content.scrollHeight;
        const blob = await toBlob(content, {
          backgroundColor: "#ffffff",
          pixelRatio: 2,
          width: w,
          height: h,
          style: { transform: "none", transformOrigin: "top left" },
        });
        if (!blob) throw new Error("PNG 변환 실패");
        return blob;
      })();
      await navigator.clipboard.write([new ClipboardItem({ "image/png": blobPromise })]);
      setCopyMsg({ ok: true, text: "복사됨. PC 카톡 채팅창에서 Ctrl+V 로 붙여넣으세요." });
    } catch (e) {
      setCopyMsg({ ok: false, text: `복사 실패: ${(e as Error).message}` });
    } finally {
      setCopying(false);
    }
  }

  const busy = printing || copying;

  return (
    <Modal onClose={onClose} size="md">
      <div className="p-5">
        <h2 className="text-base font-bold text-gray-900 mb-3">영수증 미리보기</h2>

        {loadError && (
          <div className="text-sm text-rose-600 bg-rose-50 border border-rose-200 rounded-lg px-3 py-2 mb-3">
            {loadError}
          </div>
        )}

        {!loadError && !doc && (
          <div className="text-sm text-gray-400 py-8 text-center">불러오는 중...</div>
        )}

        {doc && (
          <div className="bg-gray-50 rounded-lg p-4 mb-3 max-h-[70vh] overflow-y-auto">
            <div ref={previewRef} className="flex justify-center">
              <ReceiptPreview doc={doc} />
            </div>
          </div>
        )}

        {printError && (
          <div className="text-xs text-rose-600 bg-rose-50 border border-rose-200 rounded-lg px-3 py-2 mb-3 whitespace-pre-line">
            {printError}
          </div>
        )}

        {printed && (
          <div className="text-sm text-emerald-600 bg-emerald-50 border border-emerald-200 rounded-lg px-3 py-2 mb-3">
            출력 완료
          </div>
        )}

        {copyMsg && (
          <div className={`text-sm rounded-lg px-3 py-2 mb-3 border ${
            copyMsg.ok
              ? "text-emerald-600 bg-emerald-50 border-emerald-200"
              : "text-rose-600 bg-rose-50 border-rose-200"
          }`}>
            {copyMsg.text}
          </div>
        )}

        <div className="flex justify-end gap-2">
          <button
            onClick={onClose}
            disabled={busy}
            className="px-4 py-2 text-sm text-gray-600 border border-gray-300 rounded-lg hover:bg-gray-50 disabled:opacity-40"
          >닫기</button>
          <button
            onClick={handleCopyImage}
            disabled={!doc || busy}
            className="px-4 py-2 text-sm font-semibold text-primary border border-primary-border rounded-lg hover:bg-primary-soft disabled:opacity-40 disabled:cursor-not-allowed"
            title="이미지로 복사 — 카톡/문자/이메일 등에 Ctrl+V 로 붙여넣기"
          >
            {copying ? "복사 중..." : "카톡 복사"}
          </button>
          {!printed && (
            <button
              onClick={handlePrint}
              disabled={!bytes || busy}
              className="px-5 py-2 text-sm font-semibold text-white rounded-lg bg-primary hover:bg-primary-hover disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {printing ? "출력 중..." : "출력"}
            </button>
          )}
        </div>
      </div>
    </Modal>
  );
}
