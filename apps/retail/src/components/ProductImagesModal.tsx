"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { supabase } from "@/lib/supabase";
import { styles } from "@/common/styles";
import { keyFromR2Url } from "@/lib/r2Client";
// jszip 은 다중 다운로드 시점에만 dynamic import — 초기 번들 크기 영향 X

// MD기능 [IMG] — 상품별 이미지 업로드/관리. (사장 결정 v3)
//   - 96px 카드 + auto-fill 그리드 (30~40장도 한 화면).
//   - 드래그앤드롭 (외부 파일 + 내부 카드 분류 이동) + 섹션별 [+] 백업 버튼.
//   - 사이즈 카드 하단 항상 표시. 호버 시 ✕ 삭제.
//   - Google Drive 식 선택: 카드 클릭 = 선택 토글. 선택 시 상단 액션바 (다운로드 / URL복사).
//   - 업로드 순차 (원본 보존) + 진행률 디테일 (5/40, 현재 파일명, %) + 실패 skip.
//   - 대표/순서 UI 제거. DB 컬럼(is_main/sort_order) 유지 — 미래 export 시 활용.

type Props = {
  productId: string;
  productName: string;
  onClose: () => void;
  onSaved: () => void;
};

type ImageType = "thumbnail" | "detail" | "etc";

type ImageRow = {
  id: string;
  url: string;
  file_size: number | null;
  mime_type: string | null;
  image_type: ImageType;
  sort_order: number;
  is_main: boolean;
  created_at: string;
};

type FailEntry = { name: string; reason: string };

const IMAGE_TYPES: { code: ImageType; label: string }[] = [
  { code: "thumbnail", label: "썸네일" },
  { code: "detail",    label: "상세페이지" },
  { code: "etc",       label: "기타" },
];

function formatBytes(bytes: number | null): string {
  if (!bytes) return "-";
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

// URL → 다운로드 파일명. R2 key 끝부분 (uuid.ext) 만 추출.
function filenameFromUrl(url: string): string {
  try {
    const u = new URL(url);
    const last = u.pathname.split("/").filter(Boolean).pop();
    return last || "image.bin";
  } catch {
    return "image.bin";
  }
}

const INTERNAL_MIME = "application/x-floposs-image-id";

export default function ProductImagesModal({ productId, productName, onClose, onSaved }: Props) {
  const [loading, setLoading] = useState(true);
  const [rows, setRows] = useState<ImageRow[]>([]);
  const [uploading, setUploading] = useState(false);
  // 진행률 디테일: 현재 N/총 + 현재 파일명 + 그 파일의 % (PUT 단계 추정)
  const [progress, setProgress] = useState<{ done: number; total: number; current: string; pct: number }>({
    done: 0, total: 0, current: "", pct: 0,
  });
  const [fails, setFails] = useState<FailEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [dragOverSection, setDragOverSection] = useState<ImageType | null>(null);
  // Google Drive 식 선택
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  // 다중 다운로드 (ZIP 생성) 진행 상태
  const [downloading, setDownloading] = useState(false);
  const [downloadStatus, setDownloadStatus] = useState<string>("");
  // 다중 삭제 진행 상태
  const [deleting, setDeleting] = useState(false);
  // URL 복사 직후 1.2초 동안 ✓ 피드백 표시 (Google Drive 식)
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const fileRef = useRef<HTMLInputElement>(null);
  const pendingTypeRef = useRef<ImageType>("thumbnail");

  const fetchImages = useCallback(async () => {
    setLoading(true);
    const { data } = await supabase
      .from("product_images")
      .select("id, url, file_size, mime_type, image_type, sort_order, is_main, created_at")
      .eq("product_id", productId)
      .order("image_type", { ascending: true })
      .order("sort_order", { ascending: true })
      .order("created_at", { ascending: true });
    setRows((data ?? []) as ImageRow[]);
    setLoading(false);
  }, [productId]);

  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { fetchImages(); }, [fetchImages]);

  // PUT 진행률 — XMLHttpRequest 가 progress 이벤트 제공. fetch 는 미지원.
  function putWithProgress(url: string, file: File, onPct: (pct: number) => void): Promise<void> {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("PUT", url);
      xhr.setRequestHeader("Content-Type", file.type);
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) onPct(Math.round((e.loaded / e.total) * 100));
      };
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) resolve();
        else reject(new Error(`R2 PUT 실패 (${xhr.status})`));
      };
      xhr.onerror = () => reject(new Error("R2 네트워크 에러"));
      xhr.send(file);
    });
  }

  // 업로드 — 외부 파일 (input change 또는 drop) → 지정 분류로 박제. 순차 처리.
  async function uploadFiles(files: FileList | File[], targetType: ImageType) {
    if (!files || files.length === 0) return;
    const fileList = Array.from(files).filter(f => f.type.startsWith("image/"));
    if (fileList.length === 0) return;

    setError(null);
    setFails([]);
    setUploading(true);
    setProgress({ done: 0, total: fileList.length, current: "", pct: 0 });

    const sameTypeRows = rows.filter(r => r.image_type === targetType);
    let nextSort = sameTypeRows.length > 0
      ? Math.max(...sameTypeRows.map(r => r.sort_order)) + 1
      : 0;
    let hadAny = rows.length > 0;
    const localFails: FailEntry[] = [];

    for (let i = 0; i < fileList.length; i++) {
      const file = fileList[i];
      setProgress({ done: i, total: fileList.length, current: file.name, pct: 0 });
      try {
        const signRes = await fetch("/api/r2/sign", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ product_id: productId, mime: file.type, file_size: file.size }),
        });
        if (!signRes.ok) {
          const j = await signRes.json().catch(() => ({}));
          // 한도 초과 (403 with quota) — 사용자에게 명확 안내
          if (signRes.status === 403 && j.quota) {
            const q = j.quota as { usage_bytes?: number; quota_bytes?: number; remaining_bytes?: number };
            const used = formatBytes(q.usage_bytes ?? 0);
            const total = formatBytes(q.quota_bytes ?? 0);
            const remain = formatBytes(q.remaining_bytes ?? 0);
            throw new Error(`용량 한도 초과 — 사용 ${used} / 한도 ${total} (남은 ${remain}). 플랜 업그레이드가 필요합니다.`);
          }
          throw new Error(j.error || `sign 실패 (${signRes.status})`);
        }
        const { upload_url, public_url } = await signRes.json() as { upload_url: string; public_url: string };

        // R2 PUT — XHR 로 진행률
        await putWithProgress(upload_url, file, (pct) => {
          setProgress(p => ({ ...p, pct }));
        });

        const isFirstEver = !hadAny;
        const { error: insertError } = await supabase.from("product_images").insert({
          product_id: productId,
          url: public_url,
          file_size: file.size,
          mime_type: file.type,
          image_type: targetType,
          sort_order: nextSort,
          is_main: isFirstEver,
        });
        if (insertError) throw new Error(`DB 박제 실패: ${insertError.message}`);

        nextSort += 1;
        hadAny = true;  // 첫 장 이후로는 자동 is_main 안 줌
      } catch (e) {
        const reason = e instanceof Error ? e.message : String(e);
        localFails.push({ name: file.name, reason });
        setFails([...localFails]);
        // 1개 실패해도 나머지 계속 (continue)
      }
    }

    setProgress({ done: fileList.length, total: fileList.length, current: "", pct: 100 });
    setUploading(false);
    if (fileRef.current) fileRef.current.value = "";
    await fetchImages();
    onSaved();
  }

  async function handleDelete(row: ImageRow) {
    if (!confirm("이 이미지를 삭제할까요?\n(R2 에서도 즉시 제거됩니다.)")) return;
    const { error: dbError } = await supabase.from("product_images").delete().eq("id", row.id);
    if (dbError) {
      alert(`DB 삭제 실패: ${dbError.message}`);
      return;
    }
    const key = keyFromR2Url(row.url);
    if (key) {
      await fetch("/api/r2/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key }),
      }).catch(() => {/* orphan 허용 */});
    }
    setSelectedIds(prev => {
      const next = new Set(prev);
      next.delete(row.id);
      return next;
    });
    await fetchImages();
    onSaved();
  }

  async function changeImageType(rowId: string, newType: ImageType) {
    const row = rows.find(r => r.id === rowId);
    if (!row || row.image_type === newType) return;
    const sameType = rows.filter(r => r.image_type === newType);
    const newSort = sameType.length > 0 ? Math.max(...sameType.map(r => r.sort_order)) + 1 : 0;
    await supabase.from("product_images")
      .update({ image_type: newType, sort_order: newSort })
      .eq("id", rowId);
    await fetchImages();
    onSaved();
  }

  // ── 다운로드 (presigned GET URL 정공법) ──
  // r2.dev public URL 은 fetch CORS quirk 가 있음 → S3 endpoint + attachment 헤더로 우회.
  async function fetchPresignedUrls(targets: ImageRow[]): Promise<string[]> {
    const items = targets.map(r => {
      const key = keyFromR2Url(r.url);
      return key ? { key, filename: filenameFromUrl(r.url) } : null;
    }).filter((x): x is { key: string; filename: string } => x !== null);
    if (items.length === 0) throw new Error("유효한 R2 key 가 없습니다");
    const res = await fetch("/api/r2/sign-get", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ items }),
    });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      throw new Error(j.error || `sign-get 실패 (${res.status})`);
    }
    const { urls } = await res.json() as { urls: string[] };
    return urls;
  }

  async function downloadOne(row: ImageRow) {
    try {
      const [url] = await fetchPresignedUrls([row]);
      // presigned URL 에 attachment 헤더 박혀있어서 a.click() 만으로 다운로드 강제
      const a = document.createElement("a");
      a.href = url;
      a.download = filenameFromUrl(row.url);
      document.body.appendChild(a);
      a.click();
      a.remove();
    } catch (e) {
      alert(`다운로드 실패: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  async function downloadSelected() {
    const targets = rows.filter(r => selectedIds.has(r.id));
    if (targets.length === 0) return;
    if (targets.length === 1) {
      await downloadOne(targets[0]);
      return;
    }
    // 2개+ = ZIP 묶기 (사용자 PC 메모리에서)
    setDownloading(true);
    try {
      setDownloadStatus("다운로드 URL 발급 중...");
      const urls = await fetchPresignedUrls(targets);

      const JSZipMod = (await import("jszip")).default;
      const zip = new JSZipMod();

      for (let i = 0; i < targets.length; i++) {
        setDownloadStatus(`이미지 받는 중... ${i + 1}/${targets.length}`);
        const res = await fetch(urls[i]);
        if (!res.ok) throw new Error(`fetch 실패 (${res.status})`);
        const buf = await res.arrayBuffer();
        zip.file(filenameFromUrl(targets[i].url), buf);
      }

      setDownloadStatus("ZIP 생성 중...");
      const blob = await zip.generateAsync({ type: "blob" });
      const safeName = productName.replace(/[\\/:*?"<>|]/g, "_") || "images";
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${safeName}.zip`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (e) {
      alert(`다운로드 실패: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setDownloading(false);
      setDownloadStatus("");
    }
  }

  async function deleteSelected() {
    const targets = rows.filter(r => selectedIds.has(r.id));
    if (targets.length === 0) return;
    if (!confirm(`선택한 ${targets.length}개 이미지를 삭제할까요?\n(R2 에서도 즉시 제거됩니다.)`)) return;
    setDeleting(true);
    try {
      const ids = targets.map(r => r.id);
      const { error: dbError } = await supabase.from("product_images").delete().in("id", ids);
      if (dbError) {
        alert(`DB 삭제 실패: ${dbError.message}`);
        return;
      }
      // R2 삭제는 best-effort (orphan 허용). 한 건씩 호출.
      await Promise.allSettled(targets.map(row => {
        const key = keyFromR2Url(row.url);
        if (!key) return Promise.resolve();
        return fetch("/api/r2/delete", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ key }),
        });
      }));
      setSelectedIds(new Set());
      await fetchImages();
      onSaved();
    } finally {
      setDeleting(false);
    }
  }

  async function copyOneUrl(row: ImageRow) {
    try {
      await navigator.clipboard.writeText(row.url);
      setCopiedId(row.id);
      setTimeout(() => setCopiedId(prev => prev === row.id ? null : prev), 1200);
    } catch {
      alert("클립보드 접근 실패 — 브라우저 권한을 확인하세요.");
    }
  }

  function toggleSelect(id: string) {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function clearSelection() {
    setSelectedIds(new Set());
  }

  // ── 드래그앤드롭 ──
  function onSectionDragOver(e: React.DragEvent, type: ImageType) {
    const types = Array.from(e.dataTransfer.types);
    const isFile = types.includes("Files");
    const isInternal = types.includes(INTERNAL_MIME);
    if (!isFile && !isInternal) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = isFile ? "copy" : "move";
    if (dragOverSection !== type) setDragOverSection(type);
  }
  function onSectionDragLeave(e: React.DragEvent) {
    if (e.currentTarget.contains(e.relatedTarget as Node)) return;
    setDragOverSection(null);
  }
  async function onSectionDrop(e: React.DragEvent, targetType: ImageType) {
    e.preventDefault();
    setDragOverSection(null);
    if (e.dataTransfer.files.length > 0) {
      await uploadFiles(e.dataTransfer.files, targetType);
      return;
    }
    // 내부 카드 이동 — payload 는 JSON 배열 (단일도 [id], 다중은 [id1, id2, ...])
    const payload = e.dataTransfer.getData(INTERNAL_MIME);
    if (!payload) return;
    let ids: string[] = [];
    try {
      const parsed = JSON.parse(payload);
      ids = Array.isArray(parsed) ? parsed : [];
    } catch {
      // 옛 format (단일 id 문자열) 호환
      ids = [payload];
    }
    // 같은 분류로 옮기는 건 의미 없음 → 필터
    const toMove = ids.filter(id => {
      const r = rows.find(x => x.id === id);
      return r && r.image_type !== targetType;
    });
    if (toMove.length === 0) return;
    // 직렬로 처리 (sort_order 순서 보장)
    for (const id of toMove) {
      await changeImageType(id, targetType);
    }
    // 이동 후 선택 해제 (Google Drive 처럼 작업 끝나면 선택 풀림)
    setSelectedIds(new Set());
  }
  function onCardDragStart(e: React.DragEvent, row: ImageRow) {
    // 끄는 카드가 선택된 상태면 → 선택된 모든 카드 함께 이동
    // 선택 안 된 카드면 → 그 카드만 단독 이동 (선택 영향 X)
    const ids = selectedIds.has(row.id) && selectedIds.size > 0
      ? Array.from(selectedIds)
      : [row.id];
    e.dataTransfer.setData(INTERNAL_MIME, JSON.stringify(ids));
    e.dataTransfer.effectAllowed = "move";

    // 다중 이동 시 custom drag image — "{N}개 이동 중" chip
    if (ids.length > 1) {
      const chip = document.createElement("div");
      chip.textContent = `${ids.length}개 이동 중`;
      chip.style.cssText = [
        "position: absolute",
        "top: -9999px",
        "left: -9999px",
        "padding: 6px 12px",
        "background: #3b82f6",
        "color: white",
        "font-size: 12px",
        "font-weight: 600",
        "border-radius: 999px",
        "box-shadow: 0 4px 6px rgba(0,0,0,0.1)",
        "pointer-events: none",
        "white-space: nowrap",
      ].join("; ");
      document.body.appendChild(chip);
      e.dataTransfer.setDragImage(chip, 20, 20);
      // chip 은 다음 tick 에 제거 (브라우저가 drag image snapshot 떠간 직후)
      setTimeout(() => document.body.removeChild(chip), 0);
    }
  }

  function triggerFilePicker(type: ImageType) {
    pendingTypeRef.current = type;
    fileRef.current?.click();
  }
  function onFileInputChange(e: React.ChangeEvent<HTMLInputElement>) {
    if (e.target.files) uploadFiles(e.target.files, pendingTypeRef.current);
  }

  const totalBytes = rows.reduce((sum, r) => sum + (r.file_size ?? 0), 0);
  const selectedCount = selectedIds.size;
  const hasSelection = selectedCount > 0;

  return (
    <div className={styles.modalOverlay} onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-5xl max-h-[92vh] flex flex-col"
        onClick={e => e.stopPropagation()}>
        {/* 헤더: 선택 모드 vs 기본 모드 */}
        {hasSelection ? (
          <div className="px-6 pt-6 pb-4 border-b border-gray-100 flex items-center justify-between bg-blue-50/40">
            <div className="flex items-center gap-3">
              <button onClick={clearSelection}
                disabled={downloading || deleting}
                title="선택 해제"
                className="w-6 h-6 flex items-center justify-center border border-gray-300 rounded text-gray-700 hover:bg-white disabled:opacity-50">✕</button>
              <span className="text-sm font-bold text-black">{selectedCount}개 선택</span>
              {downloading && <span className="text-[11px] text-gray-600">{downloadStatus}</span>}
              {deleting && <span className="text-[11px] text-gray-600">삭제 중...</span>}
            </div>
            <div className="flex gap-2">
              <button onClick={downloadSelected}
                disabled={downloading || deleting}
                className="text-xs px-3 py-1.5 bg-black text-white rounded hover:bg-gray-800 disabled:bg-gray-400">
                ⬇ 다운로드 ({selectedCount})
              </button>
              <button onClick={deleteSelected}
                disabled={downloading || deleting}
                className="text-xs px-3 py-1.5 bg-red-600 text-white rounded hover:bg-red-700 disabled:bg-gray-400">
                🗑 삭제 ({selectedCount})
              </button>
            </div>
          </div>
        ) : (
          <div className="px-6 pt-6 pb-4 border-b border-gray-100 flex items-start justify-between">
            <div>
              <h3 className="text-lg font-bold text-black mb-1">상품 이미지</h3>
              <p className="text-xs text-gray-500">{productName}</p>
            </div>
            <div className="text-[11px] text-gray-500 text-right min-w-[180px]">
              <div>{rows.length}장 · {formatBytes(totalBytes)}</div>
              {uploading && (
                <div className="mt-1 space-y-0.5">
                  <div className="text-gray-700 font-medium">
                    [{progress.done + (progress.pct === 100 ? 0 : (progress.current ? 1 : 0))}/{progress.total}] 업로드 중
                  </div>
                  <div className="text-gray-500 truncate" title={progress.current}>
                    {progress.current}
                  </div>
                  <div className="w-full h-1 bg-gray-200 rounded overflow-hidden">
                    <div className="h-full bg-blue-500 transition-all"
                      style={{ width: `${progress.pct}%` }} />
                  </div>
                </div>
              )}
              {!uploading && fails.length > 0 && (
                <div className="mt-1 text-red-600 max-w-[220px]">
                  실패 {fails.length}건:
                  <ul className="mt-0.5 text-[10px] leading-tight">
                    {fails.slice(0, 3).map((f, i) => (
                      <li key={i} className="truncate" title={`${f.name}: ${f.reason}`}>
                        · {f.name}
                      </li>
                    ))}
                    {fails.length > 3 && <li>· 외 {fails.length - 3}건</li>}
                  </ul>
                </div>
              )}
              {error && <div className="mt-1 text-red-600 max-w-[220px]">{error}</div>}
            </div>
          </div>
        )}

        <input ref={fileRef}
          type="file"
          accept="image/jpeg,image/png,image/webp,image/gif,image/avif"
          multiple
          disabled={uploading}
          onChange={onFileInputChange}
          className="hidden" />

        <div className="overflow-y-auto flex-1 px-6 py-4 space-y-4">
          {loading ? (
            <p className="text-xs text-gray-400 text-center py-6">불러오는 중...</p>
          ) : (
            IMAGE_TYPES.map(t => {
              const section = rows.filter(r => r.image_type === t.code)
                .sort((a, b) => a.sort_order - b.sort_order);
              const isDragOver = dragOverSection === t.code;
              return (
                <section key={t.code}
                  onDragOver={e => onSectionDragOver(e, t.code)}
                  onDragLeave={onSectionDragLeave}
                  onDrop={e => onSectionDrop(e, t.code)}
                  className={`rounded-lg border-2 border-dashed transition-colors p-3 ${
                    isDragOver
                      ? "border-blue-500 bg-blue-50/50"
                      : "border-gray-200 bg-gray-50/30 hover:border-gray-300"
                  }`}>
                  <div className="flex items-center justify-between mb-2">
                    <h4 className="text-sm font-bold text-black flex items-center gap-2">
                      {t.label}
                      <span className="text-[11px] text-gray-400 font-normal">({section.length}장)</span>
                    </h4>
                    <button onClick={() => triggerFilePicker(t.code)}
                      disabled={uploading}
                      className="text-[11px] px-2 py-0.5 border border-gray-300 rounded text-gray-700 hover:bg-white disabled:opacity-50">
                      + 추가
                    </button>
                  </div>

                  {section.length === 0 ? (
                    <p className="text-[11px] text-gray-400 text-center py-6 select-none">
                      파일을 끌어다 놓거나 [+ 추가] 버튼으로 업로드
                    </p>
                  ) : (
                    <ul className="grid gap-2"
                      style={{ gridTemplateColumns: "repeat(auto-fill, minmax(96px, 1fr))" }}>
                      {section.map(row => {
                        const isSelected = selectedIds.has(row.id);
                        return (
                          <li key={row.id}
                            draggable
                            onDragStart={e => onCardDragStart(e, row)}
                            onClick={() => toggleSelect(row.id)}
                            className={`group relative border rounded-md overflow-hidden cursor-pointer transition-all ${
                              isSelected
                                ? "border-blue-500 ring-2 ring-blue-300 bg-blue-50"
                                : "border-gray-200 bg-white hover:border-gray-400"
                            }`}>
                            <div className="relative aspect-square bg-gray-50">
                              {/* eslint-disable-next-line @next/next/no-img-element */}
                              <img src={row.url} alt=""
                                className="w-full h-full object-cover pointer-events-none"
                                loading="lazy" />
                              {/* 좌상단: 체크박스 (선택 시 항상, 호버 시 표시) */}
                              <div className={`absolute top-1 left-1 w-5 h-5 flex items-center justify-center rounded transition-opacity text-xs ${
                                isSelected
                                  ? "bg-blue-500 text-white opacity-100"
                                  : "bg-white/80 border border-gray-300 text-transparent opacity-0 group-hover:opacity-100"
                              }`}>
                                {isSelected ? "✓" : ""}
                              </div>
                              {/* ✕ 삭제 우상단 (호버 시) */}
                              <button onClick={e => { e.stopPropagation(); handleDelete(row); }}
                                title="삭제"
                                className="absolute top-1 right-1 w-5 h-5 bg-black/70 text-white rounded text-xs leading-none opacity-0 group-hover:opacity-100 transition-opacity hover:bg-red-600">
                                ✕
                              </button>
                              {/* 🔗 URL 복사 우하단 (호버 시) — 체크박스와 멀리 분리해서 오클릭 방지 */}
                              <button onClick={e => { e.stopPropagation(); copyOneUrl(row); }}
                                title="URL 복사"
                                className={`absolute bottom-1 right-1 w-5 h-5 flex items-center justify-center rounded text-[11px] transition-opacity ${
                                  copiedId === row.id
                                    ? "bg-green-500 text-white opacity-100"
                                    : "bg-black/70 text-white opacity-0 group-hover:opacity-100 hover:bg-gray-800"
                                }`}>
                                {copiedId === row.id ? "✓" : "🔗"}
                              </button>
                            </div>
                            <div className="px-1.5 py-0.5 text-[10px] text-gray-500 text-center border-t border-gray-100 bg-white">
                              {formatBytes(row.file_size)}
                            </div>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </section>
              );
            })
          )}
        </div>

        <div className="px-6 py-4 border-t border-gray-100 flex justify-end">
          <button onClick={onClose} className={styles.btnSecondary}>닫기</button>
        </div>
      </div>
    </div>
  );
}
