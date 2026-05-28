"use client";

import { useEffect, useState, useCallback } from "react";
import { supabase } from "@/lib/supabase";
import { styles } from "@/common/styles";
import {
  type Inquiry, type InquiryReply, type InquiryCategory,
  INQUIRY_STATUS_LABEL, INQUIRY_STATUS_CLASS, INQUIRY_CATEGORY_LABEL,
  formatInquiryRelative,
} from "@/lib/inquiry";

// retail 문의함 (wholesale /dashboard/inquiries 와 동일 패턴, 자체 컴포넌트).
// 브라우저 → Supabase Seoul 직통 ([[feedback_retail_browser_supabase_direct]]).
// 작성 = inquiries INSERT(tenant_id) → admin /admin/inquiries 로 모임.
// ?compose=1 진입 시 작성 모달 자동 오픈 (푸터 "문의하기" 링크용).

type InquiryWithCount = Inquiry & { reply_count: number };
type Me = { email: string; role: string; tenant_id: string | null };

export default function RetailInquiriesPage() {
  const [list, setList] = useState<InquiryWithCount[]>([]);
  const [loading, setLoading] = useState(true);
  const [me, setMe] = useState<Me | null>(null);
  const [authChecked, setAuthChecked] = useState(false);
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
      setAuthChecked(true);
      if (!user) return;
      const meta = (user.app_metadata ?? {}) as { role?: string; tenant_id?: string };
      const m: Me = {
        email: user.email ?? "",
        role: meta.role ?? "tenant_admin",
        tenant_id: meta.tenant_id ?? null,
      };
      setMe(m);
      if (m.tenant_id) fetchAll(m.tenant_id);
    })();
  }, [fetchAll]);

  // 푸터 "문의하기" → ?compose=1 진입 시 작성 모달 자동 오픈
  useEffect(() => {
    if (me?.tenant_id && new URLSearchParams(window.location.search).get("compose") === "1") {
      setShowCompose(true);
    }
  }, [me]);

  if (authChecked && !me) {
    return (
      <main className={styles.main}>
        <div className="max-w-2xl mx-auto text-center py-16">
          <p className="text-sm text-gray-500">로그인이 필요합니다.</p>
          <a href="/login" className="mt-3 inline-block text-sm text-primary hover:underline">로그인하기 →</a>
        </div>
      </main>
    );
  }

  return (
    <main className={styles.main}>
      <div className="max-w-2xl mx-auto">
        <div className="flex items-start justify-between gap-3 mb-6">
          <div>
            <h1 className="text-xl font-bold text-black mb-1">문의</h1>
            <p className="text-xs text-gray-500">
              서비스 관련 문의를 등록하면 운영팀이 답변드립니다.
            </p>
          </div>
          <button onClick={() => setShowCompose(true)} className={styles.btnPrimary}>
            + 새 문의
          </button>
        </div>

        {loading ? (
          <p className="text-gray-400 text-sm">불러오는 중...</p>
        ) : list.length === 0 ? (
          <div className={`${styles.card} text-center py-16`}>
            <p className="text-sm text-gray-500">아직 문의가 없습니다.</p>
            <button onClick={() => setShowCompose(true)}
              className="mt-3 text-sm text-primary hover:underline">
              첫 문의 작성 →
            </button>
          </div>
        ) : (
          <ul className="bg-white rounded-2xl border border-gray-200 divide-y divide-gray-100 overflow-hidden">
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
                      <p className="text-sm font-medium text-black truncate">{i.title}</p>
                    </div>
                    <span className="text-xs text-gray-400 shrink-0">
                      {formatInquiryRelative(i.last_activity_at)}
                    </span>
                  </div>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

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
    </main>
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
    <div className={styles.modalOverlay} onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-lg" onClick={e => e.stopPropagation()}>
        <div className="px-5 py-4 border-b border-gray-100 flex items-center justify-between">
          <h3 className="font-bold text-black">새 문의 작성</h3>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-2xl leading-none">×</button>
        </div>
        <div className="p-5 space-y-3">
          <div>
            <label className={styles.modalLabel}>분류</label>
            <select value={category} onChange={e => setCategory(e.target.value as InquiryCategory)}
              className={styles.modalInput}>
              {(Object.keys(INQUIRY_CATEGORY_LABEL) as InquiryCategory[]).map(k => (
                <option key={k} value={k}>{INQUIRY_CATEGORY_LABEL[k]}</option>
              ))}
            </select>
          </div>
          <div>
            <label className={styles.modalLabel}>제목 *</label>
            <input type="text" value={title} onChange={e => setTitle(e.target.value)}
              autoFocus placeholder="문의 제목" className={styles.modalInput} />
          </div>
          <div>
            <label className={styles.modalLabel}>본문 *</label>
            <textarea value={body} onChange={e => setBody(e.target.value)}
              rows={8} placeholder="문의 내용을 자세히 적어주세요."
              className={`${styles.modalInput} resize-none`} />
          </div>
          {error && <p className={styles.msgError}>{error}</p>}
        </div>
        <div className="flex gap-2 p-5 border-t border-gray-100">
          <button onClick={onClose} disabled={submitting} className={`flex-1 ${styles.btnSecondary}`}>
            취소
          </button>
          <button onClick={handleSubmit} disabled={submitting} className={`flex-1 ${styles.btnPrimary}`}>
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
  me: Me;
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
    <div className={styles.modalOverlay} onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-2xl max-h-[85vh] flex flex-col"
        onClick={e => e.stopPropagation()}>
        <div className="px-5 py-4 border-b border-gray-100 flex items-start justify-between gap-3">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-1">
              <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${INQUIRY_STATUS_CLASS[inquiry.status]}`}>
                {INQUIRY_STATUS_LABEL[inquiry.status]}
              </span>
              <span className="text-xs text-gray-500">{INQUIRY_CATEGORY_LABEL[inquiry.category]}</span>
            </div>
            <h3 className="font-bold text-black">{inquiry.title}</h3>
            <p className="text-xs text-gray-500 mt-0.5">
              {new Date(inquiry.created_at).toLocaleString("ko-KR")}
            </p>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-2xl leading-none">×</button>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
          <Bubble isMine isAdmin={false} email={inquiry.author_email} body={inquiry.body} time={inquiry.created_at} />
          {loading ? (
            <p className="text-xs text-gray-400 text-center">답글 불러오는 중...</p>
          ) : replies.map(r => (
            <Bubble key={r.id}
              isMine={r.responder_email === me.email && !r.is_admin_reply}
              isAdmin={r.is_admin_reply}
              email={r.responder_email} body={r.body} time={r.created_at} />
          ))}
        </div>

        {inquiry.status !== "closed" && (
          <div className="px-5 py-3 border-t border-gray-100">
            <textarea value={replyBody} onChange={e => setReplyBody(e.target.value)}
              rows={3} placeholder="추가 코멘트 작성"
              className={`${styles.modalInput} resize-none`} />
            <div className="flex justify-end gap-2 mt-2">
              <button onClick={onClose} className={styles.btnSecondary}>닫기</button>
              <button onClick={submitReply} disabled={submitting || !replyBody.trim()} className={styles.btnPrimary}>
                {submitting ? "등록 중..." : "코멘트 등록"}
              </button>
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
        isAdmin ? "bg-blue-50 border border-blue-200"
        : isMine ? "bg-gray-200" : "bg-gray-100"
      }`}>
        <p className="text-xs text-gray-500 mb-1">
          {isAdmin && <span className="text-blue-600 font-medium">운영팀 · </span>}
          {email} · {new Date(time).toLocaleString("ko-KR", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}
        </p>
        <p className="text-sm text-gray-800 whitespace-pre-wrap leading-relaxed">{body}</p>
      </div>
    </div>
  );
}
