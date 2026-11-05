"use client";

import { useCallback, useEffect, useState } from "react";
import type { Variant } from "@/lib/samplesUtils";
import ImagesSection from "@/components/product-workspace/ImagesSection";
import CommentSection from "@/components/product-workspace/CommentSection";
import ShootSection from "@/components/product-workspace/ShootSection";

// MD기능 [멘트][촬영][IMG] 공용 — 세 가지를 꽉 찬 화면 하나에서 작업 (사장 결정 2026-11-05).
// 왼쪽 = 입력(멘트·촬영), 오른쪽 = 이미지. 사진을 보면서 멘트를 쓰고 착용 옵션을 고르기 위함.
// 저장 시점은 각 구역이 담당하고, 저장되면 onSaved 로 표의 등록 표시를 갱신.

export type WorkspaceSection = "comment" | "shoot" | "images";

type Props = {
  tenantId: string;
  productId: string;
  productName: string;
  wholesaleName: string;
  variants: Variant[];
  section: WorkspaceSection;
  position: { index: number; total: number };
  onPrev: () => void;
  onNext: () => void;
  onClose: () => void;
  onSaved: (productId: string) => void;
};

export default function ProductWorkspaceModal({
  tenantId, productId, productName, wholesaleName, variants, section, position, onPrev, onNext, onClose, onSaved,
}: Props) {
  const [lastModelId, setLastModelId] = useState("");
  // 이미지 업로드·다운로드·삭제·각인 진행 중에는 닫거나 상품을 바꾸지 않음 — 진행률을 놓치고 결과를 확인할 수 없게 됨
  const [imagesBusy, setImagesBusy] = useState(false);

  const close = useCallback(() => {
    if (imagesBusy) {
      alert("이미지 작업이 끝난 뒤 닫을 수 있습니다.");
      return;
    }
    onClose();
  }, [imagesBusy, onClose]);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key !== "Escape") return;
      // 입력 중 Esc 는 입력칸에서 빠져나오기만 함
      const target = e.target;
      if (target instanceof HTMLElement && target.closest("input, textarea, select")) {
        target.blur();
        return;
      }
      close();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [close]);

  return (
    <div role="dialog" aria-modal="true" aria-label="상품 작업"
      className="fixed inset-0 z-50 bg-white flex flex-col"
      // 구역 밖에 파일을 떨어뜨려도 브라우저가 파일을 열며 화면을 벗어나지 않게 막음
      onDragOver={e => e.preventDefault()}
      onDrop={e => e.preventDefault()}>
      <header className="px-5 py-3 border-b border-gray-200 flex items-center gap-3 shrink-0">
        <div className="min-w-0">
          <h3 className="text-base font-bold text-black truncate">{productName || wholesaleName || "(이름 없음)"}</h3>
          {productName && wholesaleName && <p className="text-xs text-gray-500 truncate">{wholesaleName}</p>}
        </div>
        <div className="ml-auto flex items-center gap-2 shrink-0">
          <span className="text-xs text-gray-500">{position.index + 1} / {position.total}</span>
          <button type="button" onClick={onPrev} disabled={imagesBusy || position.index <= 0}
            className="px-2.5 py-1 text-xs border border-gray-300 rounded text-gray-700 hover:bg-gray-50 disabled:opacity-30 disabled:cursor-not-allowed">
            ◀ 이전
          </button>
          <button type="button" onClick={onNext} disabled={imagesBusy || position.index >= position.total - 1}
            className="px-2.5 py-1 text-xs border border-gray-300 rounded text-gray-700 hover:bg-gray-50 disabled:opacity-30 disabled:cursor-not-allowed">
            다음 ▶
          </button>
          <button type="button" onClick={close} aria-label="닫기"
            className="ml-2 w-8 h-8 flex items-center justify-center text-xl leading-none text-gray-500 hover:text-black">×</button>
        </div>
      </header>

      {/* key: 상품이 바뀌면 입력·스크롤을 새로 시작 (이전 상품의 남은 멘트는 해제 시 저장) */}
      <div key={productId} className="flex-1 min-h-0 overflow-y-auto lg:overflow-hidden flex flex-col lg:flex-row">
        <div className="lg:w-[440px] shrink-0 lg:overflow-y-auto px-5 py-4 space-y-6 border-b lg:border-b-0 lg:border-r border-gray-200">
          <CommentSection tenantId={tenantId} productId={productId} autoFocus={section === "comment"} onSaved={onSaved} />
          <ShootSection tenantId={tenantId} productId={productId} ownVariants={variants}
            initialModelId={lastModelId} onModelChange={setLastModelId}
            autoFocus={section === "shoot"} onSaved={onSaved} />
        </div>
        <div className="flex-1 min-w-0 lg:overflow-y-auto">
          <ImagesSection productId={productId} productName={productName || wholesaleName}
            onBusyChange={setImagesBusy} onSaved={onSaved} />
        </div>
      </div>
    </div>
  );
}
