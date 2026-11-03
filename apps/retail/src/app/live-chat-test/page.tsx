"use client";

import { useEffect, useRef, useState } from "react";
import { styles } from "@/common/styles";

// 라이브채팅 주문 (TEST) — 유튜브 라이브 채팅을 받아와서 클릭하면 주문칸에 채우는 시험 화면.
// 별도 서비스로 개발 예정이라 retail 안에 임시로 둠. DB 저장 없음(새로고침하면 사라짐).
// 공식 YouTube Data API v3 를 브라우저에서 직통 호출 (키는 Google Cloud 에서 HTTP 리퍼러 제한).
//   videos.list → activeLiveChatId → liveChatMessages.list 를 pollingIntervalMillis 간격으로 반복.
// 할당량: liveChatMessages.list 1회 ≈ 5단위(추정), 하루 기본 10,000단위 → 화면에 호출 수 표시해 실측.

const API = "https://www.googleapis.com/youtube/v3";
const KEY_STORAGE = "live-chat-test:youtube-key";
const UNITS_PER_POLL = 5;

type Chat = {
  id: string;
  author: string;
  text: string;
  at: string;
  isOwner: boolean;
};

type Draft = {
  chatId: string;
  author: string;
  product: string;
  option: string;
  qty: string;
  memo: string;
};

type OrderRow = Omit<Draft, "chatId"> & { at: string };

// watch?v= · youtu.be/ · /live/ · /shorts/ · 영상ID 단독 모두 허용
function parseVideoId(input: string): string | null {
  const s = input.trim();
  if (/^[\w-]{11}$/.test(s)) return s;
  try {
    const u = new URL(s);
    if (u.hostname === "youtu.be") return u.pathname.slice(1, 12) || null;
    const v = u.searchParams.get("v");
    if (v) return v;
    const m = u.pathname.match(/\/(live|shorts|embed)\/([\w-]{11})/);
    return m ? m[2] : null;
  } catch {
    return null;
  }
}

const SIZE_RE = /(?<![A-Za-z])(XXS|XS|S|M|L|XL|XXL|2XL|3XL|FREE|F)(?![A-Za-z])/i;
const COLORS = ["블랙", "화이트", "아이보리", "베이지", "그레이", "차콜", "네이비", "블루", "소라", "카키", "그린", "브라운", "카멜", "핑크", "레드", "옐로우", "퍼플", "오트밀", "크림", "검정", "흰색"];

// "블랙 M 2개" → 옵션 "블랙 / M", 수량 2. 못 찾으면 빈칸.
function guess(text: string) {
  const color = COLORS.find(c => text.includes(c)) ?? "";
  const size = text.match(SIZE_RE)?.[1]?.toUpperCase() ?? "";
  const qty = text.match(/(\d+)\s*(개|장|벌|ea|EA)/)?.[1] ?? "";
  return { option: [color, size].filter(Boolean).join(" / "), qty };
}

function looksLikeOrder(text: string) {
  const g = guess(text);
  return Boolean(g.option || g.qty);
}

function fmtTime(iso: string) {
  return new Date(iso).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

export default function LiveChatTestPage() {
  const [apiKey, setApiKey] = useState("");
  const [link, setLink] = useState("");
  const [title, setTitle] = useState("");
  const [running, setRunning] = useState(false);
  const [error, setError] = useState("");
  const [chats, setChats] = useState<Chat[]>([]);
  const [polls, setPolls] = useState(0);
  const [intervalMs, setIntervalMs] = useState(0);
  const [minSec, setMinSec] = useState(5);
  const [onlyOrders, setOnlyOrders] = useState(false);
  const [used, setUsed] = useState<Set<string>>(new Set());
  const [draft, setDraft] = useState<Draft | null>(null);
  const [orders, setOrders] = useState<OrderRow[]>([]);
  const [product, setProduct] = useState("");

  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const runId = useRef(0);
  const minSecRef = useRef(minSec);
  minSecRef.current = minSec;

  useEffect(() => () => stop(), []);

  // 입력칸이 비어 있으면 이 브라우저에 저장된 키 → env 순으로 사용
  function resolveKey() {
    if (apiKey.trim()) return apiKey.trim();
    try { return localStorage.getItem(KEY_STORAGE) || process.env.NEXT_PUBLIC_YOUTUBE_API_KEY || ""; }
    catch { return process.env.NEXT_PUBLIC_YOUTUBE_API_KEY || ""; }
  }

  function stop() {
    runId.current++;
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    setRunning(false);
  }

  async function start() {
    setError("");
    const videoId = parseVideoId(link);
    if (!videoId) return setError("영상 링크를 알아볼 수 없어요. youtube.com/watch?v=… 또는 youtube.com/live/… 형태로 넣어주세요.");
    const rawKey = resolveKey();
    if (!rawKey) return setError("YouTube API 키를 넣어주세요.");
    try { localStorage.setItem(KEY_STORAGE, rawKey); } catch {}

    stop();
    const myRun = runId.current;
    const key = encodeURIComponent(rawKey);

    const vr = await fetch(`${API}/videos?part=liveStreamingDetails,snippet&id=${videoId}&key=${key}`);
    const vj = await vr.json();
    if (!vr.ok) return setError(`영상 정보 오류: ${vj.error?.message ?? vr.status}`);
    const item = vj.items?.[0];
    if (!item) return setError("영상을 찾을 수 없어요. 비공개거나 삭제된 영상일 수 있어요.");
    const liveChatId: string | undefined = item.liveStreamingDetails?.activeLiveChatId;
    if (!liveChatId) return setError("지금 라이브 중인 방송이 아니거나 채팅이 꺼져 있어요.");

    setTitle(`${item.snippet?.channelTitle ?? ""} · ${item.snippet?.title ?? ""}`);
    setChats([]);
    setPolls(0);
    setRunning(true);

    let pageToken = "";
    const poll = async () => {
      if (runId.current !== myRun) return;
      const url = `${API}/liveChat/messages?liveChatId=${encodeURIComponent(liveChatId)}&part=snippet,authorDetails&maxResults=2000&key=${key}` +
        (pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : "");
      try {
        const r = await fetch(url);
        const j = await r.json();
        if (runId.current !== myRun) return;
        setPolls(p => p + 1);
        if (!r.ok) {
          const reason = j.error?.errors?.[0]?.reason;
          setError(reason === "quotaExceeded" ? "오늘 API 한도를 다 썼어요. (태평양 시간 자정에 초기화)"
            : reason === "liveChatEnded" ? "방송이 끝났어요."
            : `채팅 오류: ${j.error?.message ?? r.status}`);
          return stop();
        }
        pageToken = j.nextPageToken ?? pageToken;
        const fresh: Chat[] = (j.items ?? [])
          .filter((m: { snippet?: { displayMessage?: string } }) => m.snippet?.displayMessage)
          .map((m: { id: string; snippet: { displayMessage: string; publishedAt: string }; authorDetails?: { displayName?: string; isChatOwner?: boolean } }) => ({
            id: m.id,
            author: m.authorDetails?.displayName ?? "",
            text: m.snippet.displayMessage,
            at: m.snippet.publishedAt,
            isOwner: Boolean(m.authorDetails?.isChatOwner),
          }));
        if (fresh.length) {
          setChats(prev => {
            const seen = new Set(prev.map(c => c.id));
            return [...fresh.filter(c => !seen.has(c.id)).reverse(), ...prev].slice(0, 3000);
          });
        }
        const suggested = j.pollingIntervalMillis ?? 5000;
        const wait = Math.max(suggested, minSecRef.current * 1000);
        setIntervalMs(wait);
        timer.current = setTimeout(poll, wait);
      } catch (e) {
        if (runId.current !== myRun) return;
        setError(`네트워크 오류: ${(e as Error).message}`);
        stop();
      }
    };
    poll();
  }

  function pick(c: Chat) {
    const g = guess(c.text);
    setDraft({ chatId: c.id, author: c.author, product, option: g.option, qty: g.qty || "1", memo: c.text });
  }

  function commit() {
    if (!draft) return;
    const { chatId, ...row } = draft;
    setOrders(prev => [{ ...row, at: new Date().toISOString() }, ...prev]);
    setUsed(prev => new Set(prev).add(chatId));
    setDraft(null);
  }

  const shown = onlyOrders ? chats.filter(c => looksLikeOrder(c.text)) : chats;
  const hours = intervalMs ? (10000 / UNITS_PER_POLL) * intervalMs / 3600000 : 0;

  return (
    <main className={styles.mainWide}>
      <div className="flex items-baseline gap-3 mb-4">
        <h1 className="text-lg font-bold text-black">라이브채팅 주문 (TEST)</h1>
        <span className="text-xs text-gray-500">저장 안 됨 · 새로고침하면 사라져요</span>
      </div>

      <div className={styles.cardSm + " mb-4 space-y-2"}>
        <div className="flex flex-wrap gap-2 items-center">
          <input className={styles.inputSm + " flex-1 min-w-[280px]"} placeholder="유튜브 라이브 링크 (youtube.com/watch?v=… 또는 youtube.com/live/…)"
            value={link} onChange={e => setLink(e.target.value)} onKeyDown={e => e.key === "Enter" && !running && start()} />
          {running
            ? <button className={styles.btnSecondary} onClick={stop}>중지</button>
            : <button className={styles.btnPrimary} onClick={start}>실행</button>}
        </div>
        <div className="flex flex-wrap gap-3 items-center text-xs text-gray-600">
          <label className="flex items-center gap-1">API 키
            <input type="password" className={styles.inputSm + " w-72 text-xs"} value={apiKey} onChange={e => setApiKey(e.target.value)} placeholder="AIza… (한 번 넣으면 이 브라우저에 기억)" />
          </label>
          <label className="flex items-center gap-1">최소 간격
            <select className={styles.inputSm + " text-xs"} value={minSec} onChange={e => setMinSec(Number(e.target.value))}>
              {[2, 3, 5, 10, 15].map(s => <option key={s} value={s}>{s}초</option>)}
            </select>
          </label>
          <span>호출 {polls}회 · 약 {polls * UNITS_PER_POLL}단위 사용(추정)</span>
          {running && intervalMs > 0 && <span>현재 {Math.round(intervalMs / 100) / 10}초 간격 → 하루 한도로 약 {hours.toFixed(1)}시간</span>}
        </div>
        {title && <div className="text-xs text-black">{running ? "● " : ""}{title}</div>}
        {error && <div className={styles.msgError}>{error}</div>}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[1fr_380px] gap-4">
        <section className={styles.cardSm}>
          <div className="flex items-center gap-3 mb-2">
            <span className="text-sm font-semibold text-black">채팅 {chats.length}</span>
            <label className="text-xs text-gray-600 flex items-center gap-1">
              <input type="checkbox" checked={onlyOrders} onChange={e => setOnlyOrders(e.target.checked)} />
              주문 같은 채팅만 (색상·사이즈·수량)
            </label>
            <span className="ml-auto text-xs text-gray-500">채팅을 누르면 오른쪽 주문칸에 들어가요</span>
          </div>
          <ul className="h-[65vh] overflow-y-auto divide-y divide-gray-100 text-sm">
            {shown.map(c => {
              const isUsed = used.has(c.id);
              const isPicked = draft?.chatId === c.id;
              return (
                <li key={c.id}>
                  <button type="button" onClick={() => pick(c)}
                    className={"w-full text-left px-2 py-1.5 flex gap-2 items-baseline hover:bg-primary-soft " +
                      (isPicked ? "bg-primary-soft-hover " : "") + (isUsed ? "opacity-40" : "")}>
                    <span className="text-[11px] text-gray-400 shrink-0">{fmtTime(c.at)}</span>
                    <span className={"shrink-0 font-medium " + (c.isOwner ? "text-primary" : "text-gray-700")}>{c.author}</span>
                    <span className="text-black break-all">{c.text}</span>
                    {isUsed && <span className="ml-auto shrink-0 text-[11px] text-emerald-700">주문 넘김</span>}
                  </button>
                </li>
              );
            })}
            {!shown.length && <li className="px-2 py-6 text-center text-xs text-gray-400">{running ? "채팅 기다리는 중…" : "링크를 넣고 실행을 눌러주세요"}</li>}
          </ul>
        </section>

        <aside className="space-y-4">
          <div className={styles.cardSm + " space-y-2"}>
            <label className={styles.modalLabel}>지금 방송 중인 상품</label>
            <input className={styles.inputMd} value={product} onChange={e => setProduct(e.target.value)} placeholder="예: 울 니트 가디건" />
          </div>

          <div className={styles.cardSm + " space-y-2"}>
            <div className="text-sm font-semibold text-black">주문칸</div>
            {draft ? (
              <>
                {([["author", "닉네임"], ["product", "상품"], ["option", "옵션"], ["qty", "수량"]] as const).map(([k, label]) => (
                  <div key={k}>
                    <label className={styles.modalLabel}>{label}</label>
                    <input className={styles.inputMd} value={draft[k]} onChange={e => setDraft({ ...draft, [k]: e.target.value })} />
                  </div>
                ))}
                <div>
                  <label className={styles.modalLabel}>원래 채팅</label>
                  <div className="text-xs text-gray-600 bg-gray-50 rounded px-2 py-1.5 break-all">{draft.memo}</div>
                </div>
                <div className="flex gap-2 pt-1">
                  <button className={styles.btnPrimary} onClick={commit}>주문 넘기기</button>
                  <button className={styles.btnSecondary} onClick={() => setDraft(null)}>취소</button>
                </div>
              </>
            ) : <div className="text-xs text-gray-400">왼쪽 채팅을 누르세요</div>}
          </div>

          <div className={styles.cardSm}>
            <div className="text-sm font-semibold text-black mb-2">넘긴 주문 {orders.length}</div>
            <ul className="space-y-1 text-xs max-h-64 overflow-y-auto">
              {orders.map((o, i) => (
                <li key={i} className="flex gap-2 text-black">
                  <span className="text-gray-400">{fmtTime(o.at)}</span>
                  <span className="font-medium">{o.author}</span>
                  <span>{o.product || "-"}</span>
                  <span className="text-gray-600">{o.option}</span>
                  <span className="ml-auto">{o.qty}개</span>
                </li>
              ))}
            </ul>
          </div>
        </aside>
      </div>
    </main>
  );
}
