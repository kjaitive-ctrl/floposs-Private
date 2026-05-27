"use client";

import { useEffect, useState, useCallback } from "react";
import { supabase } from "@/lib/supabase";
import {
  type Inquiry, type InquiryReply, type InquiryCategory,
  INQUIRY_STATUS_LABEL, INQUIRY_STATUS_CLASS, INQUIRY_CATEGORY_LABEL,
} from "@/lib/inquiry";
import Button from "../_components/Button";
import { PageHeader, PageActionBar, PAGE_ACTION_BAR_SPACER } from "../_components/DataTable";

type InquiryWithCount = Inquiry & { reply_count: number };

export default function DashboardInquiriesPage() {
  const [list, setList] = useState<InquiryWithCount[]>([]);
  const [loading, setLoading] = useState(true);
  const [me, setMe] = useState<{ email: string; role: string; tenant_id: string | null } | null>(null);
  const [showCompose, setShowCompose] = useState(false);
  const [selected, setSelected] = useState<InquiryWithCount | null>(null);

  const fetchAll = useCallback(async (tenantId: string) => {
    setLoading(true);
    const { data } = await supabase
      .from("inquiries")
      .select("*, inquiry_replies(count)")
      .eq("tenant_id", tenantId)
      .order("last_activity_at", { ascending: false });
    if (data) {
      const mapped = (data as unknown as (Inquiry & { inquiry_replies: { count: number }[] })[])
        .map(d => ({ ...d, reply_count: d.inquiry_replies?.[0]?.count ?? 0 }));
      setList(mapped);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    (async () => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return;
      const meta = (user.app_metadata ?? {}) as { role?: string; tenant_id?: string };
      const m = {
        email: user.email ?? "",
        role: meta.role ?? "",
        tenant_id: meta.tenant_id ?? null,
      };
      setMe(m);
      if (m.tenant_id) fetchAll(m.tenant_id);
    })();
  }, [fetchAll]);

  return (
    <div className={`max-w-4xl ${PAGE_ACTION_BAR_SPACER}`}>
      <PageHeader title="문의" subtitle="서비스 관련 문의를 등록하면 운영팀이 답변드립니다. (영업 중에도 비동기로 처리)" />

      {loading ? (
        <p className="text-gray-400 text-sm">불러오는 중...</p>
      ) : list.length === 0 ? (
        <div className="bg-white rounded-xl border border-gray-200 px-6 py-16 text-center">
          <p className="text-sm text-gray-500">아직 문의가 없습니다.</p>
          <button onClick={() => setShowCompose(true)}
            className="mt-3 text-sm text-primary hover:underline">
            첫 문의 작성 →
          </button>
        </div>
      ) : (
        <ul className="bg-white rounded-xl border border-gray-200 divide-y divide-gray-100 overflow-hidden">
          {list.map(i => (
            <li key={i.id}>
              <button onClick={() => setSelected(i)}
                className="w-full text-left px-5 py-4 hover:bg-gray-50 transition-colors">
                <div className="flex items-start justify-between gap-3">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${INQUIRY_STATUS_CLASS[i.status]}`}>
                        {INQUIRY_STATUS_LABEL[i.status]}
                      </span>
                      <span className="text-xs text-gray-400">{INQUIRY_CATEGORY_LABEL[i.category]}</span>
                      {i.reply_count > 0 && (
                        <span className="text-xs text-primary">답글 {i.reply_count}</span>
                      )}
                    </div>
                    <p className="text-sm font-medium text-gray-900 truncate">{i.title}</p>
                    <p className="text-xs text-gray-500 mt-0.5">{i.author_email}</p>
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

      {showCompose && me?.tenant_id && (
        <ComposeModal
          tenantId={me.tenant_id}
          email={me.email}
          role={me.role}
          onClose={() => setShowCompose(false)}
          onCreated={() => { setShowCompose(false); if (me.tenant_id) fetchAll(me.tenant_id); }}
        />
      )}

      {selected && me && (
        <DetailModal
          inquiry={selected}
          me={me}
          onClose={() => setSelected(null)}
          onChanged={() => { if (me.tenant_id) fetchAll(me.tenant_id); }}
        />
      )}

      <PageActionBar>
        <Button onClick={() => setShowCompose(true)}>+ 새 문의 작성</Button>
      </PageActionBar>
    </div>
  );
}

// ──────────────────────────────────────────────────
function ComposeModal({
  tenantId, email, role, onClose, onCreated,
}: {
  tenantId: string;
  email: string;
  role: string;
  onClose: () => void;
  onCreated: () => void;
}) {
  const [category, setCategory] = useState<InquiryCategory>("general");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  async function handleSubmit() {
    if (!title.trim()) return setError("제목을 입력해주세요.");
    if (!body.trim()) return setError("본문을 입력해주세요.");
    setSubmitting(true);
    setError("");
    const { error: err } = await supabase.from("inquiries").insert({
      author_email: email,
      author_role: role,
      tenant_id: tenantId,
      category,
      title: title.trim(),
      body: body.trim(),
    });
    setSubmitting(false);
    if (err) { setError("등록 실패: " + err.message); return; }
    onCreated();
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-white rounded-2xl w-full max-w-lg" onClick={e => e.stopPropagation()}>
        <div className="px-5 py-4 border-b border-gray-100 flex items-center justify-between">
          <h3 className="font-bold text-gray-900">새 문의 작성</h3>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-2xl leading-none">×</button>
        </div>
        <div className="p-5 space-y-3">
          <div>
            <label className="block text-xs text-gray-600 mb-1">분류</label>
            <select value={category} onChange={e => setCategory(e.target.value as InquiryCategory)}
              className="w-full input-md">
              {(Object.keys(INQUIRY_CATEGORY_LABEL) as InquiryCategory[]).map(k => (
                <option key={k} value={k}>{INQUIRY_CATEGORY_LABEL[k]}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-xs text-gray-600 mb-1">제목 *</label>
            <input type="text" value={title} onChange={e => setTitle(e.target.value)}
              autoFocus placeholder="문의 제목"
              className="w-full input-md" />
          </div>
          <div>
            <label className="block text-xs text-gray-600 mb-1">본문 *</label>
            <textarea value={body} onChange={e => setBody(e.target.value)}
              rows={8} placeholder="문의 내용을 자세히 적어주세요."
              className="w-full input-md resize-none" />
          </div>
          {error && <p className="text-sm text-red-500">{error}</p>}
        </div>
        <div className="flex gap-2 p-5 border-t border-gray-100">
          <button onClick={onClose} disabled={submitting}
            className="flex-1 py-2.5 border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50 text-sm">
            취소
          </button>
          <button onClick={handleSubmit} disabled={submitting}
            className="flex-1 py-2.5 bg-primary text-white rounded-lg hover:bg-primary-hover disabled:opacity-50 text-sm font-medium">
            {submitting ? "등록 중..." : "문의 등록"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ──────────────────────────────────────────────────
function DetailModal({
  inquiry, me, onClose, onChanged,
}: {
  inquiry: InquiryWithCount;
  me: { email: string; role: string; tenant_id: string | null };
  onClose: () => void;
  onChanged: () => void;
}) {
  const [replies, setReplies] = useState<InquiryReply[]>([]);
  const [loading, setLoading] = useState(true);
  const [replyBody, setReplyBody] = useState("");
  const [submitting, setSubmitting] = useState(false);

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
    const { error } = await supabase.from("inquiry_replies").insert({
      inquiry_id: inquiry.id,
      responder_email: me.email,
      responder_role: me.role,
      is_admin_reply: false,
      body: replyBody.trim(),
    });
    setSubmitting(false);
    if (error) { alert("답글 등록 실패: " + error.message); return; }
    setReplyBody("");
    fetchReplies();
    onChanged();
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-white rounded-2xl w-full max-w-2xl max-h-[85vh] flex flex-col"
        onClick={e => e.stopPropagation()}>
        <div className="px-5 py-4 border-b border-gray-100 flex items-start justify-between gap-3">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-1">
              <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${INQUIRY_STATUS_CLASS[inquiry.status]}`}>
                {INQUIRY_STATUS_LABEL[inquiry.status]}
              </span>
              <span className="text-xs text-gray-500">{INQUIRY_CATEGORY_LABEL[inquiry.category]}</span>
            </div>
            <h3 className="font-bold text-gray-900">{inquiry.title}</h3>
            <p className="text-xs text-gray-500 mt-0.5">
              {new Date(inquiry.created_at).toLocaleString("ko-KR")}
            </p>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-2xl leading-none">×</button>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
          <Bubble isMine={inquiry.author_email === me.email} isAdmin={false}
            email={inquiry.author_email} body={inquiry.body} time={inquiry.created_at} />
          {loading ? (
            <p className="text-xs text-gray-400 text-center">답글 불러오는 중...</p>
          ) : replies.map(r => (
            <Bubble key={r.id}
              isMine={r.responder_email === me.email}
              isAdmin={r.is_admin_reply}
              email={r.responder_email} body={r.body} time={r.created_at} />
          ))}
        </div>

        {inquiry.status !== "closed" && (
          <div className="px-5 py-3 border-t border-gray-100">
            <textarea value={replyBody} onChange={e => setReplyBody(e.target.value)}
              rows={3} placeholder="추가 코멘트 작성"
              className="w-full input-md resize-none" />
            <div className="flex justify-end gap-2 mt-2">
              <Button variant="secondary" onClick={onClose}>닫기</Button>
              <Button onClick={submitReply} disabled={submitting || !replyBody.trim()}>
                {submitting ? "등록 중..." : "코멘트 등록"}
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function Bubble({
  isMine, isAdmin, email, body, time,
}: {
  isMine: boolean;
  isAdmin: boolean;
  email: string;
  body: string;
  time: string;
}) {
  return (
    <div className={`flex ${isMine ? "justify-end" : "justify-start"}`}>
      <div className={`max-w-[80%] rounded-2xl px-4 py-3 ${
        isAdmin ? "bg-primary-soft border border-primary-border"
        : isMine ? "bg-gray-200" : "bg-gray-100"
      }`}>
        <p className="text-xs text-gray-500 mb-1">
          {isAdmin && <span className="text-primary font-medium">운영팀 · </span>}
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
