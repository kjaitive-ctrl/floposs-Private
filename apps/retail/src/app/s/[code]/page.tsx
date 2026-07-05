"use client";

import { useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { supabaseBoard, boardEmail } from "@/lib/supabase-board";

// 전자노트 보드 (도매 수신) — 프라이버시 게이트.
// 미인증: 티저(매장명·건수만) + 게이트(클레임=전화매칭+비번 / 로그인=비번).
// 인증(클레이머): 상세 주문 + 출고수량/메모 입력. [[project_logi_axis]]

interface FullItem {
  id: string;
  supplier_product_name: string | null;
  consumer_product_name: string | null;
  supplier_option_label: string | null;
  consumer_option_label: string | null;
  quantity: number;
  unit_price: number;
  shipped_quantity: number | null;
  ship_memo: string | null;
}
interface BoardNote {
  id: string;
  sent_at: string;
  is_test: boolean;
  pickup_status?: "pending" | "picked" | "failed";
  sender: { company_name: string | null } | { company_name: string | null }[] | null;
  items?: FullItem[];      // 인증 시
  item_count?: number;     // 티저
  total_qty?: number;      // 티저
}
interface Head { store_name: string; loc: string; claimed: boolean; authed: boolean; }

type Draft = { shipped: string; memo: string };

export default function NoteBoardPage() {
  const code = useParams<{ code: string }>().code;

  const [head, setHead] = useState<Head | null>(null);
  const [notes, setNotes] = useState<BoardNote[]>([]);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);

  // 게이트
  const [phone, setPhone] = useState("");
  const [password, setPassword] = useState("");
  const [gateBusy, setGateBusy] = useState(false);
  const [gateError, setGateError] = useState<string | null>(null);

  // 출고 입력 draft (itemId → {shipped, memo})
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [savingNote, setSavingNote] = useState<string | null>(null);
  const [savedNote, setSavedNote] = useState<string | null>(null);

  const getToken = useCallback(async () => {
    const { data: { session } } = await supabaseBoard.auth.getSession();
    return session?.access_token ?? null;
  }, []);

  const fetchBoard = useCallback(async (token: string | null) => {
    const res = await fetch(`/api/note-board/${code}`, {
      cache: "no-store",
      headers: token ? { Authorization: `Bearer ${token}` } : undefined,
    });
    if (!res.ok) return null;
    return res.json() as Promise<Head & { notes: BoardNote[] }>;
  }, [code]);

  const reload = useCallback(async () => {
    if (!code) return;
    setLoading(true);
    const token = await getToken();
    const data = await fetchBoard(token);
    if (!data) { setNotFound(true); setLoading(false); return; }
    setHead({ store_name: data.store_name, loc: data.loc, claimed: data.claimed, authed: data.authed });
    setNotes(data.notes ?? []);
    if (data.authed) {
      const d: Record<string, Draft> = {};
      for (const n of data.notes ?? []) for (const it of n.items ?? []) {
        d[it.id] = { shipped: it.shipped_quantity != null ? String(it.shipped_quantity) : "", memo: it.ship_memo ?? "" };
      }
      setDrafts(d);
    }
    setLoading(false);
  }, [code, getToken, fetchBoard]);

  useEffect(() => { reload(); }, [reload]);

  // 로그인 (비번)
  async function doLogin() {
    setGateBusy(true); setGateError(null);
    const { error } = await supabaseBoard.auth.signInWithPassword({ email: boardEmail(code), password });
    setGateBusy(false);
    if (error) { setGateError("비밀번호가 올바르지 않습니다."); return; }
    setPassword("");
    reload();
  }

  // 클레임 (전화매칭 + 비번 설정) → 성공 시 자동 로그인
  async function doClaim() {
    setGateBusy(true); setGateError(null);
    const res = await fetch(`/api/board-auth/claim`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code, phone, password }),
    });
    const r = await res.json().catch(() => ({}));
    if (!res.ok) {
      setGateBusy(false);
      if (r.claimed) { setHead(h => h ? { ...h, claimed: true } : h); setGateError("이미 등록된 보드입니다. 비밀번호로 로그인하세요."); return; }
      setGateError(r.error ?? "등록에 실패했습니다.");
      return;
    }
    const { error } = await supabaseBoard.auth.signInWithPassword({ email: boardEmail(code), password });
    setGateBusy(false);
    if (error) { setGateError("등록됐지만 로그인에 실패했습니다. 비밀번호로 다시 로그인해주세요."); setHead(h => h ? { ...h, claimed: true } : h); return; }
    setPhone(""); setPassword("");
    reload();
  }

  async function logout() {
    await supabaseBoard.auth.signOut();
    reload();
  }

  async function saveNote(note: BoardNote) {
    setSavingNote(note.id); setSavedNote(null);
    const token = await getToken();
    const items = (note.items ?? []).map(it => ({
      id: it.id,
      shipped_quantity: drafts[it.id]?.shipped === "" ? null : Number(drafts[it.id]?.shipped),
      ship_memo: drafts[it.id]?.memo ?? null,
    }));
    const res = await fetch(`/api/note-board/${code}/feedback`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ items }),
    });
    setSavingNote(null);
    if (!res.ok) { const r = await res.json().catch(() => ({})); alert(r.error ?? "저장 실패"); return; }
    setSavedNote(note.id);
  }

  const senderName = (n: BoardNote) => {
    const s = Array.isArray(n.sender) ? n.sender[0] : n.sender;
    return s?.company_name ?? "소매";
  };
  const dateOf = (s: string) => s.slice(0, 10);
  const timeOf = (s: string) => s.slice(11, 16);

  if (loading) return <main className="min-h-screen bg-gray-50 flex items-center justify-center text-sm text-gray-400">불러오는 중…</main>;
  if (notFound || !head) return <main className="min-h-screen bg-gray-50 flex items-center justify-center text-sm text-gray-500">존재하지 않는 주소입니다.</main>;

  // 날짜 그룹
  const groups: { date: string; notes: BoardNote[] }[] = [];
  for (const n of notes) {
    const d = dateOf(n.sent_at);
    const last = groups[groups.length - 1];
    if (last && last.date === d) last.notes.push(n); else groups.push({ date: d, notes: [n] });
  }
  const teaserTotal = notes.reduce((a, n) => a + (n.total_qty ?? 0), 0);

  return (
    <main className="min-h-screen bg-gray-50 px-4 py-6">
      <div className="max-w-2xl mx-auto">
        {/* 헤더 */}
        <div className="bg-white rounded-2xl border border-gray-200 px-5 py-4 mb-4 flex items-start justify-between">
          <div>
            <div className="text-[11px] text-gray-400 mb-0.5">전자노트 · 들어온 주문</div>
            <h1 className="text-xl font-bold text-black">
              {head.store_name}
              {head.loc && <span className="text-gray-400 font-normal text-base"> · {head.loc}</span>}
            </h1>
          </div>
          {head.authed && (
            <button onClick={logout} className="text-xs text-gray-400 hover:text-black whitespace-nowrap">로그아웃</button>
          )}
        </div>

        {/* 미인증 = 게이트 + 티저 */}
        {!head.authed ? (
          <>
            <div className="bg-white rounded-2xl border border-gray-200 p-6 mb-4">
              <h2 className="text-sm font-bold text-black mb-1">
                {head.claimed ? "보드 로그인" : "이 매장 보드를 처음 여시나요?"}
              </h2>
              <p className="text-xs text-gray-500 mb-4">
                {head.claimed
                  ? "비밀번호를 입력하면 들어온 주문 상세를 보고 출고 회신을 남길 수 있습니다."
                  : "매장 전화번호로 본인 확인 후 비밀번호를 설정하세요. (사장님 매장만 등록 가능)"}
              </p>
              <div className="space-y-2 max-w-xs">
                {!head.claimed && (
                  <input type="tel" inputMode="numeric" placeholder="매장 전화번호" value={phone}
                    onChange={e => setPhone(e.target.value)}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm" />
                )}
                <input type="password" placeholder={head.claimed ? "비밀번호" : "새 비밀번호 (6자 이상)"} value={password}
                  onChange={e => setPassword(e.target.value)}
                  onKeyDown={e => { if (e.key === "Enter") (head.claimed ? doLogin() : doClaim()); }}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm" />
                {gateError && <p className="text-xs text-red-600">⚠ {gateError}</p>}
                <button onClick={head.claimed ? doLogin : doClaim} disabled={gateBusy}
                  className="w-full py-2 bg-primary text-white text-sm rounded-lg hover:bg-primary-hover disabled:opacity-50">
                  {gateBusy ? "처리 중…" : head.claimed ? "로그인" : "본인 확인하고 시작"}
                </button>
                {!head.claimed && (
                  <button onClick={() => setHead(h => h ? { ...h, claimed: true } : h)}
                    className="w-full text-xs text-gray-400 hover:text-gray-700">이미 비밀번호가 있어요 →</button>
                )}
              </div>
            </div>
            <div className="text-center text-xs text-gray-400">
              {notes.length > 0 ? `들어온 주문 ${notes.length}건 · ${teaserTotal}개 (로그인 후 상세 표시)` : "아직 들어온 주문이 없습니다."}
            </div>
          </>
        ) : (
          /* 인증 = 상세 + 출고 입력 */
          notes.length === 0 ? (
            <div className="text-center text-sm text-gray-400 bg-white rounded-2xl border border-gray-200 py-16">아직 들어온 주문이 없습니다.</div>
          ) : (
            <div className="space-y-4">
              {groups.map(g => (
                <div key={g.date}>
                  <div className="text-xs font-semibold text-gray-500 mb-1.5">{g.date} <span className="text-gray-300 font-normal">· {g.notes.length}건</span></div>
                  <ul className="space-y-2">
                    {g.notes.map(n => (
                      <li key={n.id} className="bg-white rounded-xl border border-gray-200 overflow-hidden">
                        <div className="px-3 py-1.5 bg-gray-50 border-b border-gray-100 flex items-center gap-2">
                          <span className="font-semibold text-black text-xs">{senderName(n)}</span>
                          {n.is_test && <span className="text-[10px] text-amber-700 bg-amber-50 border border-amber-200 rounded px-1">테스트</span>}
                          {n.pickup_status === "picked" && <span className="text-[10px] text-emerald-700 bg-emerald-50 border border-emerald-200 rounded px-1">픽업완료</span>}
                          {n.pickup_status === "failed" && <span className="text-[10px] text-red-700 bg-red-50 border border-red-200 rounded px-1">픽업실패</span>}
                          <span className="ml-auto text-[11px] text-gray-400">{timeOf(n.sent_at)}</span>
                        </div>
                        <table className="w-full text-xs">
                          <thead className="text-gray-400">
                            <tr>
                              <th className="px-3 py-1 text-left font-normal">상품</th>
                              <th className="px-2 py-1 text-left font-normal">옵션</th>
                              <th className="px-2 py-1 text-right font-normal">주문</th>
                              <th className="px-2 py-1 text-center font-normal">출고</th>
                              <th className="px-3 py-1 text-left font-normal">메모(입고예정 등)</th>
                            </tr>
                          </thead>
                          <tbody>
                            {(n.items ?? []).map(it => (
                              <tr key={it.id} className="border-t border-gray-50">
                                <td className="px-3 py-1 text-black">{it.supplier_product_name || it.consumer_product_name || "(상품)"}</td>
                                <td className="px-2 py-1 text-gray-500 whitespace-nowrap">{it.supplier_option_label || it.consumer_option_label || "-"}</td>
                                <td className="px-2 py-1 text-right text-black font-medium whitespace-nowrap">{it.quantity}</td>
                                <td className="px-2 py-1 text-center">
                                  <input type="number" min={0} value={drafts[it.id]?.shipped ?? ""}
                                    onChange={e => setDrafts(d => ({ ...d, [it.id]: { ...d[it.id], shipped: e.target.value } }))}
                                    className="w-14 px-1 py-0.5 border border-gray-300 rounded text-center" placeholder={String(it.quantity)} />
                                </td>
                                <td className="px-3 py-1">
                                  <input type="text" value={drafts[it.id]?.memo ?? ""}
                                    onChange={e => setDrafts(d => ({ ...d, [it.id]: { ...d[it.id], memo: e.target.value } }))}
                                    className="w-full px-1.5 py-0.5 border border-gray-300 rounded" placeholder="예: 다음주 입고예정" />
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                        <div className="px-3 py-2 flex items-center justify-end gap-2 border-t border-gray-100">
                          {savedNote === n.id && <span className="text-[11px] text-emerald-600">저장됨</span>}
                          <button onClick={() => saveNote(n)} disabled={savingNote === n.id}
                            className="text-xs px-3 py-1 bg-primary text-white rounded-lg hover:bg-primary-hover disabled:opacity-50">
                            {savingNote === n.id ? "저장 중…" : "출고 회신 저장"}
                          </button>
                        </div>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          )
        )}
        <p className="text-center text-[11px] text-gray-300 mt-6">floposs 전자노트</p>
      </div>
    </main>
  );
}
