"use client";

// 영수증 미리보기 — 클라이언트 HTML 렌더.
// monospace + 영수증 폭 시각 흉내. 실제 출력 bytes는 서버 API 가 생성.
// 줄 단위 정렬/굵기/크기/구분선 그대로 재현.
// 부모 컨테이너 폭이 영수증 폭보다 좁으면 transform: scale 로 자동 축소.

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ReceiptDoc, ReceiptLine } from "./types";

function renderLine(line: ReceiptLine, charsPerLine: number, idx: number): React.ReactElement | null {
  switch (line.kind) {
    case "text": {
      const sizeCls = line.size === 3 ? "text-2xl" : line.size === 2 ? "text-lg" : "text-sm";
      const boldCls = line.bold ? "font-bold" : "";
      const alignCls = line.align === "center" ? "text-center" : line.align === "right" ? "text-right" : "text-left";
      // ※ 로 시작하는 미송 표시 — ※ 만 bold + 약간 간격 (1px)
      if (line.text.startsWith("※") && !line.bold) {
        return (
          <div key={idx} className={`${sizeCls} ${alignCls} whitespace-pre-wrap break-all`}>
            <span className="font-bold" style={{ marginRight: "1px" }}>※</span>
            <span>{line.text.slice(1)}</span>
          </div>
        );
      }
      return (
        <div key={idx} className={`${sizeCls} ${boldCls} ${alignCls} whitespace-pre-wrap break-all`}>
          {line.text}
        </div>
      );
    }
    case "kv": {
      const boldCls = line.bold ? "font-bold" : "";
      return (
        <div key={idx} className={`flex justify-between text-sm ${boldCls}`}>
          <span>{line.left}</span>
          <span>{line.right}</span>
        </div>
      );
    }
    case "row3": {
      const sizeCls = line.size === 2 ? "text-base" : "text-sm";
      const boldCls = line.bold ? "font-bold" : "";
      return (
        <div key={idx} className={`flex ${sizeCls} ${boldCls}`}>
          <span className="flex-1 text-left">{line.left}</span>
          <span className="w-12 text-right">{line.middle}</span>
          <span className="w-20 text-right">{line.right}</span>
        </div>
      );
    }
    case "rule": {
      // CSS border — inline-style 로 명시해서 html-to-image (PNG 변환) 도 정확히 캡처.
      // ESC/POS 출력본은 toEscPos 가 ─ ═ 박스 그리기 글자로 변환.
      const ch = line.char ?? "-";
      const style: React.CSSProperties = ch === "="
        ? { borderTop: "3px double #1f2937", marginTop: 6, marginBottom: 6, height: 0 }
        : ch === "_"
        ? { borderTop: "1px solid #9ca3af",  marginTop: 4, marginBottom: 4, height: 0 }
        :   { borderTop: "1px solid #1f2937",  marginTop: 4, marginBottom: 4, height: 0 };
      return <div key={idx} style={style} />;
    }
    case "barcode":
      return (
        <div key={idx} className="text-center my-1">
          <div className="text-[8px] text-gray-400">[ Code128 바코드 ]</div>
          <div className="font-mono text-xs text-gray-600">{line.value}</div>
        </div>
      );
    case "blank":
      return <div key={idx} className="h-3" />;
    case "cut":
      return (
        <div key={idx} className="border-t-2 border-dashed border-gray-400 mt-3 pt-1 text-[10px] text-gray-400 text-center">
          ✂ 절단
        </div>
      );
  }
}

export function ReceiptPreview({ doc }: { doc: ReceiptDoc }) {
  // 80mm = ~302px (96dpi 기준). 58mm = ~219px.
  const widthPx = doc.paperWidth === 80 ? 320 : 240;

  const wrapperRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);
  const [contentHeight, setContentHeight] = useState(0);

  // 부모 폭 + 콘텐츠 실제 높이 측정 → scale 계산.
  // wrap height = contentHeight × scale 이라 height 변경이 wrap reflow 유발 → ResizeObserver 진동.
  // rAF 디바운스 + 임계값 비교로 진동 차단.
  useLayoutEffect(() => {
    const wrap = wrapperRef.current;
    const content = contentRef.current;
    if (!wrap || !content) return;

    let raf: number | null = null;
    let lastScale = -1;
    let lastHeight = -1;

    const apply = () => {
      raf = null;
      const cw = wrap.clientWidth || widthPx;
      const newScale = Math.min(1, cw / widthPx);
      const newHeight = content.offsetHeight;
      if (Math.abs(newScale - lastScale) > 0.005) {
        lastScale = newScale;
        setScale(newScale);
      }
      if (Math.abs(newHeight - lastHeight) > 1) {
        lastHeight = newHeight;
        setContentHeight(newHeight);
      }
    };
    const update = () => {
      if (raf != null) return;
      raf = requestAnimationFrame(apply);
    };

    update();
    const ro = new ResizeObserver(update);
    ro.observe(wrap);
    ro.observe(content);
    return () => {
      if (raf != null) cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, [widthPx, doc.lines.length]);

  // doc 변경 시 높이 재측정 (lines 길이 외 내용 변경도)
  useEffect(() => {
    if (contentRef.current) setContentHeight(contentRef.current.offsetHeight);
  }, [doc]);

  return (
    <div
      ref={wrapperRef}
      className="w-full flex justify-center"
      style={contentHeight > 0 ? { height: Math.round(contentHeight * scale) } : undefined}
    >
      <div
        ref={contentRef}
        data-receipt-content
        className="bg-white font-mono px-3 py-4 leading-tight"
        style={{
          width: `${widthPx}px`,
          transform: `scale(${scale})`,
          transformOrigin: "top center",
          fontFamily: "'D2Coding', 'Consolas', 'Courier New', monospace",
        }}
      >
        {doc.lines.map((line, i) => renderLine(line, doc.charsPerLine, i))}
      </div>
    </div>
  );
}
