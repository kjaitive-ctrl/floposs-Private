"use client";

import { useEffect, useState, useCallback } from "react";
import { supabase } from "@/lib/supabase";
import {
  type Inquiry, type InquiryReply, type InquiryStatus,
  INQUIRY_STATUS_LABEL, INQUIRY_STATUS_CLASS, INQUIRY_CATEGORY_LABEL,
} from "@/lib/inquiry";

type InquiryWithMeta = Inquiry & {
  reply_count: number;
  tenants: { company_name: string } | null;
};

export default function AdminInquiriesPage() {
  const [list, setList] = useState<InquiryWithMeta[]>([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState<"all" | InquiryStatus>("open");
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<InquiryWithMeta | null>(null);

  const fetchAll = useCallback(async () => {
    setLoading(true);
    const { data } = await supabase
      .from("inquiries")
      .select("*, tenants(company_name), inquiry_replies(count)")
      .order("last_activity_at", { ascending: false });
    if (data) {
      const mapped = (data as unknown as (Inquiry & {
        tenants: { company_name: string } | null;
        inquiry_replies: { count: number }[];
      })[]).map(d => ({
        ...d,
        reply_count: d.inquiry_replies?.[0]?.count ?? 0,
      }));
      setList(mapped);
    }
    setLoading(false);
  }, []);

  useEffect(() => { fetchAll(); }, [fetchAll]);

  const counts = {
    open: list.filter(i => i.status === "open").length,
    in_progress: list.filter(i => i.status === "in_progress").length,
    resolved: list.filter(i => i.status === "resolved").length,
    closed: list.filter(i => i.status === "closed").length,
  };

  const filtered = list
    .filter(i => statusFilter === "all" || i.status === statusFilter)
    .filter(i => {
      if (!search) return true;
      const q = search.toLowerCase();
      return i.title.toLowerCase().includes(q)
        || i.body.toLowerCase().includes(q)
        || i.author_email.toLowerCase().includes(q)
        || (i.tenants?.company_name ?? "").toLowerCase().includes(q);
    });

  return (
    <div className="max-w-6xl">
      <div className="mb-6">
        <h2 className="text-2xl font-bold text-gray-900">문의처리</h2>
        <p className="text-sm text-gray-500 mt-0.5">
          도매/소매 사용자가 dashboard 에서 작성한 문의가 모입니다.
        </p>
      </div>

      {/* 요약 카드 */}
      <div className="grid grid-cols-4 gap-4 mb-6">
        {([
          { key: "open", label: "신규 접수", color: "text-orange-600" },
          { key: "in_progress", label: "처리중", color: "text-primary" },
          { key: "resolved", label: "해결됨", color: "text-green-600" },
          { key: "closed", label: "종결", color: "text-gray-500" },
        ] as const).map(c => (
          <button key={c.key} onClick={() => setStatusFilter(c.key)}
            className={`bg-white rounded-xl border px-4 py-3 text-left transition-colors ${
              statusFilter === c.key ? "border-primary" : "border-gray-200 hover:border-gray-300"
            }`}>
            <p className="text-xs text-gray-500">{c.label}</p>
            <p className={`text-xl font-bold mt-1 ${c.color}`}>{counts[c.key]}건</p>
          </button>
        ))}
      </div>

      {/* 필터 */}
      <div className="flex gap-3 mb-4">
        <button onClick={() => setStatusFilter("all")}
          className={`px-3 py-2 rounded-lg text-sm transition-colors ${
            statusFilter === "all"
              ? "bg-primary text-white"
              : "bg-white border border-gray-300 text-gray-600 hover:bg-gray-50"
          }`}>
          전체 ({list.length})
        </button>
        <input type="text" placeholder="제목/본문/작성자/업체명 검색" value={search}
          onChange={e => setSearch(e.target.value)}
          className="flex-1 max-w-sm input-md" />
      </div>

      {/* 목록 */}
      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
        {loading ? (
          <p className="text-center py-10 text-gray-400 text-sm">불러오는 중...</p>
        ) : filtered.length === 0 ? (
          <p className="text-center py-10 text-gray-400 text-sm">
            {statusFilter === "open" ? "신규 문의가 없습니다." : "조건에 맞는 문의가 없습니다."}
          </p>
        ) : (
          <ul className="divide-y divide-gray-100">
            {filtered.map(i => (
              <li key={i.id}>
                <button onClick={() => setSelected(i)}
                  className="w-full text-left px-5 py-4 hover:bg-gray-50 transition-colors">
                  <div className="flex items-start justify-between gap-3 mb-1">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-0.5">
                        <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${INQUIRY_STATUS_CLASS[i.status]}`}>
                          {INQUIRY_STATUS_LABEL[i.status]}
                        </span>
                        <span className="text-xs text-gray-400">
                          {INQUIRY_CATEGORY_LABEL[i.category]}
                        </span>
                        {i.reply_count > 0 && (
                          <span className="text-xs text-primary">
                            답글 {i.reply_count}
                          </span>
                        )}
                      </div>
                      <p className="text-sm font-medium text-gray-900 truncate">{i.title}</p>
                      <p className="text-xs text-gray-500 mt-0.5">
                        {i.tenants?.company_name && <span className="font-medium">{i.tenants.company_name} · </span>}
                        {i.author_email}
                      </p>
                    </div>
                    <span className="text-xs text-gray-400 shrink-0">
                      {formatRelative(i.last_activity_at)}
                    </span>
                  </div>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {selected && (
        <InquiryDetailModal
          inquiry={selected}
          onClose={() => setSelected(null)}
          onChanged={() => { fetchAll(); }}
        />
      )}
    </div>
  );
}

function InquiryDetailModal({
  inquiry, onClose, onChanged,
}: {
  inquiry: InquiryWithMeta;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [replies, setReplies] = useState<InquiryReply[]>([]);
  const [loading, setLoading] = useState(true);
  const [replyBody, setReplyBody] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [status, setStatus] = useState<InquiryStatus>(inquiry.status);

  const fetchReplies = useCallback(async () => {
    setLoading(true);
    const { data } = await supabase
      .from("inquiry_replies")
      .select("*")
      .eq("inquiry_id", inquiry.id)
      .order("created_at");
    if (data) setReplies(data as InquiryReply[]);
    setLoading(false);
  }, [inquiry.id]);

  useEffect(() => { fetchReplies(); }, [fetchReplies]);

  async function submitReply() {
    if (!replyBody.trim()) return;
    setSubmitting(true);
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) { setSubmitting(false); return; }

    const { error } = await supabase.from("inquiry_replies").insert({
      inquiry_id: inquiry.id,
      responder_email: user.email,
      responder_role: "super_admin",
      is_admin_reply: true,
      body: replyBody.trim(),
    });
    setSubmitting(false);
    if (error) { alert("답변 등록 실패: " + error.message); return; }
    setReplyBody("");
    fetchReplies();
    onChanged();
  }

  async function changeStatus(next: InquiryStatus) {
    if (next === status) return;
    const { error } = await supabase
      .from("inquiries")
      .update({ status: next })
      .eq("id", inquiry.id);
    if (error) { alert("상태 변경 실패: " + error.message); return; }
    setStatus(next);
    onChanged();
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-white rounded-2xl w-full max-w-2xl max-h-[85vh] flex flex-col"
        onClick={e => e.stopPropagation()}>
        {/* 헤더 */}
        <div className="px-5 py-4 border-b border-gray-100 flex items-start justify-between gap-3">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-1">
              <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${INQUIRY_STATUS_CLASS[status]}`}>
                {INQUIRY_STATUS_LABEL[status]}
              </span>
              <span className="text-xs text-gray-500">{INQUIRY_CATEGORY_LABEL[inquiry.category]}</span>
            </div>
            <h3 className="font-bold text-gray-900">{inquiry.title}</h3>
            <p className="text-xs text-gray-500 mt-0.5">
              {inquiry.tenants?.company_name && <span className="font-medium">{inquiry.tenants.company_name} · </span>}
              {inquiry.author_email} · {new Date(inquiry.created_at).toLocaleString("ko-KR")}
            </p>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-2xl leading-none">×</button>
        </div>

        {/* 상태 변경 */}
        <div className="px-5 py-3 bg-gray-50 border-b border-gray-100 flex items-center gap-2">
          <span className="text-xs text-gray-600">상태:</span>
          {(Object.keys(INQUIRY_STATUS_LABEL) as InquiryStatus[]).map(s => (
            <button key={s} onClick={() => changeStatus(s)}
              className={`text-xs px-2.5 py-1 rounded-lg transition-colors ${
                status === s
                  ? INQUIRY_STATUS_CLASS[s] + " font-medium"
                  : "border border-gray-300 text-gray-500 hover:bg-white"
              }`}>
              {INQUIRY_STATUS_LABEL[s]}
            </button>
          ))}
        </div>

        {/* 본문 + 스레드 */}
        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
          <Bubble
            isAdmin={false} email={inquiry.author_email}
            body={inquiry.body}
            time={inquiry.created_at}
          />
          {loading ? (
            <p className="text-xs text-gray-400 text-center">답글 불러오는 중...</p>
          ) : (
            replies.map(r => (
              <Bubble key={r.id}
                isAdmin={r.is_admin_reply} email={r.responder_email}
                body={r.body} time={r.created_at}
              />
            ))
          )}
        </div>

        {/* 답변 입력 */}
        <div className="px-5 py-3 border-t border-gray-100">
          <textarea value={replyBody} onChange={e => setReplyBody(e.target.value)}
            rows={3} placeholder="답변 작성"
            className="w-full input-md resize-none" />
          <div className="flex justify-end gap-2 mt-2">
            <button onClick={onClose}
              className="px-4 py-2 border border-gray-300 text-gray-600 text-sm rounded-lg hover:bg-gray-50">
              닫기
            </button>
            <button onClick={submitReply} disabled={submitting || !replyBody.trim()}
              className="px-4 py-2 bg-primary text-white text-sm rounded-lg hover:bg-primary-hover disabled:opacity-50">
              {submitting ? "등록 중..." : "답변 등록"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function Bubble({
  isAdmin, email, body, time,
}: {
  isAdmin: boolean;
  email: string;
  body: string;
  time: string;
}) {
  return (
    <div className={`flex ${isAdmin ? "justify-end" : "justify-start"}`}>
      <div className={`max-w-[80%] rounded-2xl px-4 py-3 ${
        isAdmin ? "bg-primary-soft border border-primary-border" : "bg-gray-100"
      }`}>
        <p className="text-xs text-gray-500 mb-1">
          {isAdmin && <span className="text-primary font-medium">관리자 · </span>}
          {email} · {new Date(time).toLocaleString("ko-KR", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}
        </p>
        <p className="text-sm text-gray-800 whitespace-pre-wrap leading-relaxed">{body}</p>
      </div>
    </div>
  );
}

function formatRelative(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const min = Math.floor(diff / 60000);
  if (min < 1) return "방금";
  if (min < 60) return `${min}분 전`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}시간 전`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}일 전`;
  return new Date(iso).toLocaleDateString("ko-KR");
}
