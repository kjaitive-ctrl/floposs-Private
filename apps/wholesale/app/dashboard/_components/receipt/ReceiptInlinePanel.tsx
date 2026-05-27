"use client";

// 영수증 인라인 미리보기 패널 — 모달 없이 페이지 안에 직접 임베드.
// orderId 변경 시 자동 리프레시. 버튼은 미리보기 우상단에 배치.

import { useEffect, useRef, useState } from "react";
import { ReceiptPreview } from "./ReceiptPreview";
import { fetchReceiptBytes } from "./index";
import { ensureQzConnected, getDefaultPrinter, printRawBase64 } from "./printerTransport";
import type { ReceiptDoc } from "./types";

type Props = {
  orderId: string | null;
  onPrinted?: () => void;
};

export function ReceiptInlinePanel({ orderId, onPrinted }: Props) {
  const [doc, setDoc] = useState<ReceiptDoc | null>(null);
  const [bytes, setBytes] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [printError, setPrintError] = useState<string | null>(null);
  const [printing, setPrinting] = useState(false);
  const [copying, setCopying] = useState(false);
  const [copyMsg, setCopyMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const previewRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setDoc(null);
    setBytes(null);
    setLoadError(null);
    setPrintError(null);
    setCopyMsg(null);
    if (!orderId) return;
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
      const blobPromise = (async () => {
        const { toBlob } = await import("html-to-image");
        // 캡처 시 transform: scale() 무효화 + 명시 width/height 로 전체 콘텐츠 보장.
        // 적용된 scale 그대로 캡처하면 bounds 가 어긋나 헤더만 잡힘.
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
      setCopyMsg({ ok: true, text: "복사됨. 카톡 채팅창에서 Ctrl+V" });
    } catch (e) {
      setCopyMsg({ ok: false, text: `복사 실패: ${(e as Error).message}` });
    } finally {
      setCopying(false);
    }
  }

  const busy = printing || copying;
  const disabled = !doc || busy;

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="shrink-0 flex items-center justify-between mb-2 h-7">
        <span className="text-xs font-semibold text-gray-600">영수증 미리보기</span>
        <div className="flex gap-1">
          <button
            onClick={handleCopyImage}
            disabled={disabled}
            className="px-2 py-0.5 text-xs font-medium text-primary border border-primary-border rounded hover:bg-primary-soft disabled:opacity-40 disabled:cursor-not-allowed"
            title="이미지로 복사 — 카톡/문자/이메일 등에 Ctrl+V"
          >{copying ? "복사 중..." : "카톡 복사"}</button>
          <button
            onClick={handlePrint}
            disabled={disabled || !bytes}
            className="px-2 py-0.5 text-xs font-semibold text-white rounded bg-primary hover:bg-primary-hover disabled:opacity-40 disabled:cursor-not-allowed"
          >{printing ? "출력 중..." : "출력"}</button>
        </div>
      </div>

      {/* scrollbar-gutter:stable — scrollbar 공간 항상 reserve.
          ReceiptPreview 의 ResizeObserver 가 scrollbar toggle 로 진동하는 것 차단. */}
      <div className="flex-1 overflow-y-scroll overflow-x-hidden bg-gray-50 rounded-lg py-2 px-0.5 min-h-0 [scrollbar-gutter:stable]">
        {!orderId && (
          <div className="text-xs text-gray-400 py-8 text-center">주문을 선택하세요</div>
        )}
        {orderId && loadError && (
          <div className="text-xs text-rose-600 bg-rose-50 border border-rose-200 rounded px-2 py-1">
            {loadError}
          </div>
        )}
        {orderId && !loadError && !doc && (
          <div className="text-xs text-gray-400 py-8 text-center">불러오는 중...</div>
        )}
        {doc && (
          <div ref={previewRef} className="flex justify-center">
            <ReceiptPreview doc={doc} />
          </div>
        )}
      </div>

      {(printError || copyMsg) && (
        <div className="shrink-0 mt-1">
          {printError && (
            <div className="text-[10px] text-rose-600 bg-rose-50 border border-rose-200 rounded px-2 py-1 whitespace-pre-line">
              {printError}
            </div>
          )}
          {copyMsg && (
            <div className={`text-[10px] rounded px-2 py-1 border ${
              copyMsg.ok
                ? "text-emerald-600 bg-emerald-50 border-emerald-200"
                : "text-rose-600 bg-rose-50 border-rose-200"
            }`}>
              {copyMsg.text}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
