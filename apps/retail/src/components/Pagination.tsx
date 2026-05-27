"use client";

// /samples + /products 표 푸터 페이지네이션.
// 1-based page. 현재 ±3 + 양끝(첫/마지막) 노출, 사이는 "…".

interface Props {
  page: number;
  pageSize: number;
  total: number;
  onChange: (page: number) => void;
}

export default function Pagination({ page, pageSize, total, onChange }: Props) {
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const start = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const end   = Math.min(total, page * pageSize);

  const set = new Set<number>([1, totalPages]);
  for (let i = Math.max(1, page - 3); i <= Math.min(totalPages, page + 3); i++) set.add(i);
  const pages = Array.from(set).sort((a, b) => a - b);

  const btn = "min-w-[28px] px-2 py-1 rounded border text-xs";
  const btnIdle = btn + " border-gray-200 text-gray-600 hover:text-black hover:bg-gray-50";
  const btnActive = btn + " border-black text-black font-medium bg-gray-100";
  const navBtn = "px-2 py-1 border border-gray-200 rounded text-xs text-gray-600 hover:text-black disabled:opacity-40 disabled:cursor-not-allowed";

  return (
    <div className="flex items-center gap-1 px-4 py-2 border-t border-gray-200 bg-white">
      <span className="mr-auto text-xs text-gray-600">
        {start.toLocaleString()}–{end.toLocaleString()} / 총 {total.toLocaleString()}개
      </span>
      <button onClick={() => onChange(Math.max(1, page - 1))} disabled={page <= 1} className={navBtn}>‹</button>
      {pages.map((p, i) => {
        const prev = pages[i - 1];
        const gap = prev !== undefined && p - prev > 1;
        return (
          <span key={p} className="flex items-center gap-1">
            {gap && <span className="px-1 text-gray-400 text-xs">…</span>}
            <button onClick={() => onChange(p)} className={p === page ? btnActive : btnIdle}>{p}</button>
          </span>
        );
      })}
      <button onClick={() => onChange(Math.min(totalPages, page + 1))} disabled={page >= totalPages} className={navBtn}>›</button>
    </div>
  );
}
