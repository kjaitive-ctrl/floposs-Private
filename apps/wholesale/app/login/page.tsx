"use client";

import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import { redirectAuthedUser } from "@/lib/loginRedirect";
import { useRouter } from "next/navigation";
import { usePlatformSettings, BusinessInfoFooter } from "@floposs/ui";

type Mode = "login" | "signup";

type AccountType = {
  id: string;
  code: string;
  label: string;
  description: string | null;
  dashboard_route: string;
  display_order: number;
};

export default function LoginPage() {
  const router = useRouter();
  const [mode, setMode] = useState<Mode>("login");
  const [authChecking, setAuthChecking] = useState(true);
  // 사업자 정보 + 서비스 브랜딩 — admin/general-settings 단일 관리. packages/ui hook 사용.
  const settings = usePlatformSettings(supabase);

  // 이미 로그인된 사용자가 /login 진입 시 본인 메인페이지로 즉시 이동
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data: { user } } = await supabase.auth.getUser();
      if (cancelled) return;
      if (user) {
        await redirectAuthedUser(user, router);
        // navigation 시작 — authChecking 풀지 않음 (잔상 깜빡임 방지)
        return;
      }
      setAuthChecking(false);
    })();
    return () => { cancelled = true; };
  }, [router]);

  if (authChecking) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-gray-50 to-gray-100">
        <p className="text-sm text-gray-400">불러오는 중...</p>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-gray-50 to-gray-100 px-4 py-10">
      <div className="w-full max-w-md">
        <div className="bg-white rounded-2xl shadow-lg border border-gray-100 p-8">
          <Header mode={mode} brandLetter={settings?.service_brand_letter ?? "F"} />
          {mode === "login" ? (
            <LoginForm router={router} onGoSignup={() => setMode("signup")} />
          ) : (
            <SignupFlow onBackToLogin={() => setMode("login")} />
          )}
        </div>
        {/* 공간 미리 예약 — settings 비동기 로드돼도 높이 안 변해 카드 떨림 방지 */}
        <div className="min-h-[140px]">
          <BusinessInfoFooter settings={settings} />
        </div>
      </div>
    </div>
  );
}

// ────────────────────────────────────────────────────────
// Header
// ────────────────────────────────────────────────────────
function Header({ mode, brandLetter }: { mode: Mode; brandLetter: string }) {
  return (
    <div className="text-center mb-6">
      <div className="inline-flex w-12 h-12 rounded-xl bg-primary text-white items-center justify-center text-lg font-bold mb-2">
        {brandLetter}
      </div>
      <h1 className="text-2xl font-bold text-gray-900">
        {mode === "login" ? "로그인" : "회원가입"}
      </h1>
      <p className="text-sm text-gray-500 mt-1">
        {mode === "login"
          ? "이메일로 본인의 서비스에 접속합니다"
          : "이용하실 서비스를 선택해주세요"}
      </p>
    </div>
  );
}

// ────────────────────────────────────────────────────────
// 공용 컴포넌트
// ────────────────────────────────────────────────────────
function Spinner() {
  return (
    <svg className="animate-spin h-4 w-4 text-white" viewBox="0 0 24 24" fill="none">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-75" fill="currentColor"
        d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
    </svg>
  );
}

function PasswordInput({
  value, onChange, placeholder, required, autoComplete,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  required?: boolean;
  autoComplete?: string;
}) {
  const [visible, setVisible] = useState(false);
  return (
    <div className="relative">
      <input
        type={visible ? "text" : "password"}
        value={value}
        onChange={e => onChange(e.target.value)}
        required={required}
        autoComplete={autoComplete}
        placeholder={placeholder}
        className="w-full px-4 py-2.5 pr-11 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary-ring"
      />
      <button
        type="button"
        onClick={() => setVisible(v => !v)}
        tabIndex={-1}
        aria-label={visible ? "비밀번호 숨기기" : "비밀번호 표시"}
        className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 text-xs"
      >
        {visible ? "숨기기" : "표시"}
      </button>
    </div>
  );
}

function FieldError({ message }: { message?: string }) {
  if (!message) return null;
  return (
    <div className="flex items-start gap-1.5 text-sm text-red-600 mt-1.5">
      <span className="leading-none mt-0.5">⚠</span>
      <span>{message}</span>
    </div>
  );
}

// ────────────────────────────────────────────────────────
// 로그인 폼
// ────────────────────────────────────────────────────────
function LoginForm({
  router, onGoSignup,
}: {
  router: ReturnType<typeof useRouter>;
  onGoSignup: () => void;
}) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError("");

    const { data, error: authError } = await supabase.auth.signInWithPassword({
      email, password,
    });

    if (authError || !data.user) {
      setError("이메일 또는 비밀번호가 올바르지 않습니다.");
      setLoading(false);
      return;
    }

    await redirectAuthedUser(data.user, router);
  }

  return (
    <form onSubmit={handleLogin} className="space-y-4">
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1">이메일</label>
        <input
          type="email" value={email} onChange={e => setEmail(e.target.value)} required
          autoFocus autoComplete="email"
          placeholder="example@company.com"
          className="w-full px-4 py-2.5 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary-ring"
        />
      </div>
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1">비밀번호</label>
        <PasswordInput
          value={password} onChange={setPassword} required
          autoComplete="current-password"
          placeholder="비밀번호 입력"
        />
        <FieldError message={error} />
      </div>
      <button
        type="submit" disabled={loading}
        className="w-full py-2.5 bg-primary text-white rounded-lg text-sm font-medium hover:bg-primary-hover disabled:opacity-60 flex items-center justify-center gap-2"
      >
        {loading && <Spinner />}
        {loading ? "로그인 중..." : "로그인"}
      </button>

      <div className="pt-4 mt-2 border-t border-gray-100 text-center">
        <span className="text-sm text-gray-500">처음이세요? </span>
        <button type="button" onClick={onGoSignup}
          className="text-sm text-primary hover:text-primary-hover font-medium">
          회원가입 →
        </button>
      </div>
    </form>
  );
}

// ────────────────────────────────────────────────────────
// 회원가입 흐름 (업종 라디오 → 업종별 폼)
// ────────────────────────────────────────────────────────
function SignupFlow({ onBackToLogin }: { onBackToLogin: () => void }) {
  const [accountTypes, setAccountTypes] = useState<AccountType[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedCode, setSelectedCode] = useState<string>("");

  // 회원가입 클릭 시점에만 fetch (LoginPage 마운트 시점엔 호출 안 됨)
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { data } = await supabase
          .from("account_types")
          .select("id, code, label, description, dashboard_route, display_order")
          .eq("is_signup_enabled", true)
          .order("display_order");
        if (!cancelled && data) setAccountTypes(data as AccountType[]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  if (loading) {
    return <p className="text-center text-sm text-gray-400 py-8">불러오는 중...</p>;
  }
  if (accountTypes.length === 0) {
    return (
      <div className="text-center py-8">
        <p className="text-sm text-gray-500">현재 신규 가입을 받지 않습니다.</p>
        <button onClick={onBackToLogin}
          className="mt-4 text-sm text-primary hover:underline">← 로그인으로 돌아가기</button>
      </div>
    );
  }

  const selected = accountTypes.find(t => t.code === selectedCode);

  return (
    <div>
      {/* 업종 라디오 */}
      <div className="space-y-2 mb-5">
        {accountTypes.map(t => (
          <label key={t.code}
            className={`flex items-start gap-3 p-3 border rounded-lg cursor-pointer transition-colors ${
              selectedCode === t.code
                ? "border-primary-ring bg-primary-soft"
                : "border-gray-200 hover:border-gray-300"
            }`}>
            <input type="radio" name="account_type" value={t.code}
              checked={selectedCode === t.code}
              onChange={() => setSelectedCode(t.code)}
              className="mt-1 accent-primary" />
            <div className="flex-1">
              <div className="font-medium text-sm text-gray-900">{t.label}</div>
              {t.description && (
                <div className="text-xs text-gray-500 mt-0.5">{t.description}</div>
              )}
            </div>
          </label>
        ))}
      </div>

      {/* 선택된 업종에 따른 폼 */}
      {selected && (
        <SignupForm accountType={selected} onBackToLogin={onBackToLogin} />
      )}

      <div className="pt-4 mt-2 border-t border-gray-100 text-center">
        <button type="button" onClick={onBackToLogin}
          className="text-sm text-gray-500 hover:text-gray-700">
          ← 로그인으로 돌아가기
        </button>
      </div>
    </div>
  );
}

// ────────────────────────────────────────────────────────
// 업종별 가입 폼 (code 분기)
// ────────────────────────────────────────────────────────
function SignupForm({
  accountType, onBackToLogin,
}: {
  accountType: AccountType;
  onBackToLogin: () => void;
}) {
  if (accountType.code === "wholesale") return <WholesaleSignupForm onBackToLogin={onBackToLogin} />;
  if (accountType.code === "retail")    return <RetailSignupForm onBackToLogin={onBackToLogin} />;
  // 신규 업종 추가 시 fallback (단순 폼). 실제 업종은 위에 분기 추가.
  return (
    <div className="p-4 bg-yellow-50 border border-yellow-200 rounded-lg text-sm text-yellow-700">
      &quot;{accountType.label}&quot; 업종 가입 폼이 아직 준비 중입니다. 곧 제공됩니다.
    </div>
  );
}

// ────────────────────────────────────────────────────────
// 도매 가입
// ────────────────────────────────────────────────────────
function WholesaleSignupForm({ onBackToLogin }: { onBackToLogin: () => void }) {
  const [company, setCompany] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [password2, setPassword2] = useState("");
  const [agreedTerms, setAgreedTerms] = useState(false);
  const [agreedPrivacy, setAgreedPrivacy] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState(false);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!company.trim()) return setError("업체명을 입력해주세요.");
    if (password !== password2) return setError("비밀번호가 일치하지 않습니다.");
    if (password.length < 6) return setError("비밀번호는 6자 이상이어야 합니다.");
    if (!agreedTerms || !agreedPrivacy) return setError("약관 및 개인정보처리방침에 동의해주세요.");
    setLoading(true);
    setError("");

    const res = await fetch("/api/auth/signup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password, company_name: company }),
    });
    const json = await res.json();
    setLoading(false);
    if (!res.ok) return setError(json.error ?? "회원가입 실패");
    setSuccess(true);
  }

  if (success) {
    return (
      <SuccessPanel
        title="가입 신청 완료"
        body={<>이메일 확인 후 로그인하시거나,<br />관리자 승인 후 서비스를 이용할 수 있습니다.</>}
        onBackToLogin={onBackToLogin}
      />
    );
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <Field label="업체명" required>
        <input type="text" value={company} onChange={e => setCompany(e.target.value)} required
          autoFocus placeholder="사업체 이름"
          className="w-full px-4 py-2.5 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary-ring" />
      </Field>
      <Field label="이메일" required>
        <input type="email" value={email} onChange={e => setEmail(e.target.value)} required
          autoComplete="email" placeholder="로그인 시 사용할 이메일"
          className="w-full px-4 py-2.5 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary-ring" />
      </Field>
      <Field label="비밀번호" required>
        <PasswordInput value={password} onChange={setPassword} required
          autoComplete="new-password" placeholder="6자 이상" />
      </Field>
      <Field label="비밀번호 확인" required>
        <PasswordInput value={password2} onChange={setPassword2} required
          autoComplete="new-password" placeholder="비밀번호 재입력" />
        <FieldError message={error} />
      </Field>

      <LegalConsentBox
        agreedTerms={agreedTerms} setAgreedTerms={setAgreedTerms}
        agreedPrivacy={agreedPrivacy} setAgreedPrivacy={setAgreedPrivacy} />

      <button type="submit" disabled={loading}
        className="w-full py-2.5 bg-primary text-white rounded-lg text-sm font-medium hover:bg-primary-hover disabled:opacity-60 flex items-center justify-center gap-2">
        {loading && <Spinner />}
        {loading ? "처리 중..." : "회원가입"}
      </button>
      <p className="text-xs text-gray-400 text-center">가입 후 관리자 검토가 있을 수 있습니다.</p>
    </form>
  );
}

// ────────────────────────────────────────────────────────
// 소매 가입
// ────────────────────────────────────────────────────────
function RetailSignupForm({ onBackToLogin }: { onBackToLogin: () => void }) {
  const [company, setCompany] = useState("");
  const [owner, setOwner] = useState("");
  const [phone, setPhone] = useState("");
  const [bizNum, setBizNum] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [password2, setPassword2] = useState("");
  const [agreedTerms, setAgreedTerms] = useState(false);
  const [agreedPrivacy, setAgreedPrivacy] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState(false);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!company.trim()) return setError("업체명을 입력해주세요.");
    if (password !== password2) return setError("비밀번호가 일치하지 않습니다.");
    if (password.length < 6) return setError("비밀번호는 6자 이상이어야 합니다.");
    if (!agreedTerms || !agreedPrivacy) return setError("약관 및 개인정보처리방침에 동의해주세요.");
    setLoading(true);
    setError("");

    const res = await fetch("/api/auth/retail-signup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email, password,
        company_name: company,
        owner_name: owner,
        phone, business_number: bizNum,
      }),
    });
    const json = await res.json();
    setLoading(false);
    if (!res.ok) return setError(json.error ?? "회원가입 실패");
    setSuccess(true);
  }

  if (success) {
    return (
      <SuccessPanel
        title="소매 가입 완료"
        body={<>로그인 후 소매 사이트로 이동됩니다.</>}
        onBackToLogin={onBackToLogin}
      />
    );
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-5">
      {/* 회사 정보 */}
      <Section title="회사 정보">
        <Field label="업체명" required>
          <input type="text" value={company} onChange={e => setCompany(e.target.value)} required
            autoFocus placeholder="소매업체 이름"
            className="w-full px-4 py-2.5 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary-ring" />
        </Field>
        <Field label="대표자명">
          <input type="text" value={owner} onChange={e => setOwner(e.target.value)}
            placeholder="대표자 이름"
            className="w-full px-4 py-2.5 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary-ring" />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="연락처">
            <input type="text" value={phone} onChange={e => setPhone(e.target.value)}
              placeholder="010-0000-0000"
              className="w-full px-4 py-2.5 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary-ring" />
          </Field>
          <Field label="사업자번호">
            <input type="text" value={bizNum} onChange={e => setBizNum(e.target.value)}
              placeholder="000-00-00000"
              className="w-full px-4 py-2.5 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary-ring" />
          </Field>
        </div>
      </Section>

      {/* 계정 정보 */}
      <Section title="계정 정보">
        <Field label="이메일" required>
          <input type="email" value={email} onChange={e => setEmail(e.target.value)} required
            autoComplete="email" placeholder="로그인 시 사용할 이메일"
            className="w-full px-4 py-2.5 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary-ring" />
        </Field>
        <Field label="비밀번호" required>
          <PasswordInput value={password} onChange={setPassword} required
            autoComplete="new-password" placeholder="6자 이상" />
        </Field>
        <Field label="비밀번호 확인" required>
          <PasswordInput value={password2} onChange={setPassword2} required
            autoComplete="new-password" placeholder="비밀번호 재입력" />
          <FieldError message={error} />
        </Field>
      </Section>

      <LegalConsentBox
        agreedTerms={agreedTerms} setAgreedTerms={setAgreedTerms}
        agreedPrivacy={agreedPrivacy} setAgreedPrivacy={setAgreedPrivacy} />

      <button type="submit" disabled={loading}
        className="w-full py-2.5 bg-primary text-white rounded-lg text-sm font-medium hover:bg-primary-hover disabled:opacity-60 flex items-center justify-center gap-2">
        {loading && <Spinner />}
        {loading ? "처리 중..." : "소매 회원가입"}
      </button>
    </form>
  );
}

// ────────────────────────────────────────────────────────
// 소형 헬퍼
// ────────────────────────────────────────────────────────
function Field({ label, required, children }: { label: string; required?: boolean; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-sm font-medium text-gray-700 mb-1">
        {label}{required && <span className="text-red-500 ml-0.5">*</span>}
      </label>
      {children}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">{title}</div>
      <div className="space-y-3">{children}</div>
    </div>
  );
}

function SuccessPanel({
  title, body, onBackToLogin,
}: {
  title: string;
  body: React.ReactNode;
  onBackToLogin: () => void;
}) {
  return (
    <div className="text-center py-4">
      <div className="w-12 h-12 bg-green-100 rounded-full flex items-center justify-center mx-auto mb-3">
        <span className="text-green-600 text-xl">✓</span>
      </div>
      <h3 className="font-bold text-gray-900 mb-1">{title}</h3>
      <p className="text-sm text-gray-500">{body}</p>
      <button onClick={onBackToLogin}
        className="mt-4 text-sm text-primary hover:underline">
        로그인하기 →
      </button>
    </div>
  );
}

// ────────────────────────────────────────────────────────
// 약관/개인정보 동의 + 본문 모달
// ────────────────────────────────────────────────────────
type LegalKind = "terms" | "privacy";

function LegalConsentBox({
  agreedTerms, setAgreedTerms, agreedPrivacy, setAgreedPrivacy,
}: {
  agreedTerms: boolean;
  setAgreedTerms: (v: boolean) => void;
  agreedPrivacy: boolean;
  setAgreedPrivacy: (v: boolean) => void;
}) {
  const [openKind, setOpenKind] = useState<LegalKind | null>(null);
  const allAgreed = agreedTerms && agreedPrivacy;

  return (
    <div className="border border-gray-200 rounded-lg p-3 space-y-2 bg-gray-50">
      <label className="flex items-center gap-2 cursor-pointer">
        <input type="checkbox" checked={allAgreed}
          onChange={e => { setAgreedTerms(e.target.checked); setAgreedPrivacy(e.target.checked); }}
          className="w-4 h-4 accent-primary" />
        <span className="text-sm font-medium text-gray-800">전체 동의</span>
      </label>
      <div className="border-t border-gray-200 pt-2 space-y-1.5">
        <ConsentRow
          checked={agreedTerms} onChange={setAgreedTerms}
          label="이용약관 동의" required onView={() => setOpenKind("terms")} />
        <ConsentRow
          checked={agreedPrivacy} onChange={setAgreedPrivacy}
          label="개인정보처리방침 동의" required onView={() => setOpenKind("privacy")} />
      </div>
      {openKind && (
        <LegalDocumentModal kind={openKind} onClose={() => setOpenKind(null)} />
      )}
    </div>
  );
}

function ConsentRow({
  checked, onChange, label, required, onView,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  required?: boolean;
  onView: () => void;
}) {
  return (
    <div className="flex items-center justify-between">
      <label className="flex items-center gap-2 cursor-pointer flex-1">
        <input type="checkbox" checked={checked}
          onChange={e => onChange(e.target.checked)}
          className="w-4 h-4 accent-primary" />
        <span className="text-sm text-gray-700">
          {label}
          {required && <span className="text-red-500 ml-1">*</span>}
        </span>
      </label>
      <button type="button" onClick={onView}
        className="text-xs text-primary hover:underline">
        보기
      </button>
    </div>
  );
}

function LegalDocumentModal({ kind, onClose }: { kind: LegalKind; onClose: () => void }) {
  const [body, setBody] = useState<string | null>(null);
  const [version, setVersion] = useState<string>("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data } = await supabase
        .from("legal_documents")
        .select("body, version")
        .eq("kind", kind)
        .order("effective_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (cancelled) return;
      if (data) { setBody(data.body); setVersion(data.version); }
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [kind]);

  const title = kind === "terms" ? "이용약관" : "개인정보처리방침";

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-white rounded-2xl w-full max-w-2xl max-h-[80vh] flex flex-col"
        onClick={e => e.stopPropagation()}>
        <div className="p-5 border-b border-gray-100 flex items-center justify-between">
          <div>
            <h3 className="text-lg font-bold text-gray-900">{title}</h3>
            {version && <p className="text-xs text-gray-400 mt-0.5">버전 {version}</p>}
          </div>
          <button onClick={onClose}
            className="text-gray-400 hover:text-gray-600 text-2xl leading-none">×</button>
        </div>
        <div className="p-5 overflow-y-auto">
          {loading ? (
            <p className="text-sm text-gray-400">불러오는 중...</p>
          ) : body ? (
            <pre className="text-sm text-gray-700 whitespace-pre-wrap leading-relaxed">{body}</pre>
          ) : (
            <p className="text-sm text-gray-400">아직 등록된 문서가 없습니다.</p>
          )}
        </div>
        <div className="p-4 border-t border-gray-100 text-right">
          <button onClick={onClose}
            className="px-4 py-2 bg-primary text-white text-sm rounded-lg hover:bg-primary-hover">
            닫기
          </button>
        </div>
      </div>
    </div>
  );
}
