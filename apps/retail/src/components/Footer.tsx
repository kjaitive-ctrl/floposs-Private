"use client";

import { useEffect, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { usePlatformSettings } from "@floposs/ui";
import { supabase } from "@/lib/supabase";
import { formatBizNumber } from "@/lib/orderPortal";

// retail-site 공용 푸터.
//   - 사업자 정보 = platform_settings DB-driven ([[feedback_central_source_of_truth]], 하드코드 X).
//   - 이용약관/개인정보처리방침 = legal_documents 최신본 모달 (wholesale login 과 동일 패턴).
//   - 문의하기 = 로그인 시 /dashboard/inquiries(작성 모달 자동 오픈), 비로그인 시 /login 안내.
//   - /order 외부주문 포털(집중 흐름)에서는 숨김. NavBar 와 동일 정책.

type LegalKind = "terms" | "privacy";

export default function Footer() {
  const pathname = usePathname();
  const router = useRouter();
  const settings = usePlatformSettings(supabase);
  const [openLegal, setOpenLegal] = useState<LegalKind | null>(null);

  // 외부 주문 포털은 자체 집중 흐름 — 푸터 숨김 (NavBar 와 동일)
  if (pathname.startsWith("/order")) return null;

  async function handleInquiry() {
    const { data: { user } } = await supabase.auth.getUser();
    if (user) router.push("/dashboard/inquiries?compose=1");
    else router.push("/login");
  }

  // 간결한 한 줄 사업자정보 ( | 구분, 길면 wrap). hardcode X — platform_settings.
  const infoParts = settings ? [
    settings.company_name,
    settings.representative_name && `대표 ${settings.representative_name}`,
    settings.business_number && `사업자등록번호 ${formatBizNumber(settings.business_number)}`,
    settings.ecommerce_license && `통신판매업 ${settings.ecommerce_license}`,
    settings.address,
    settings.contact_email && `고객센터 ${settings.contact_email}`,
  ].filter(Boolean) as string[] : [];

  return (
    <footer className="border-t border-gray-100 mt-12 py-5 px-6">
      <div className="max-w-5xl mx-auto text-center">
        {infoParts.length > 0 && (
          <p className="text-[11px] text-gray-400 leading-relaxed">
            {infoParts.map((part, i) => (
              <span key={i}>
                {i > 0 && <span className="text-gray-300 mx-1.5">|</span>}
                {part}
              </span>
            ))}
          </p>
        )}
        <div className="flex items-center justify-center gap-3 mt-2 text-[11px] text-gray-500">
          <button onClick={() => setOpenLegal("terms")} className="hover:text-black hover:underline">
            이용약관
          </button>
          <span className="text-gray-300">|</span>
          <button onClick={() => setOpenLegal("privacy")} className="hover:text-black hover:underline font-medium">
            개인정보처리방침
          </button>
          <span className="text-gray-300">|</span>
          <button onClick={handleInquiry} className="hover:text-black hover:underline">
            문의하기
          </button>
        </div>
      </div>

      {openLegal && (
        <LegalModal kind={openLegal} onClose={() => setOpenLegal(null)} />
      )}
    </footer>
  );
}

// ── 약관/개인정보 본문 모달 (legal_documents 최신본 fetch) ──
function LegalModal({ kind, onClose }: { kind: LegalKind; onClose: () => void }) {
  const [body, setBody] = useState<string | null>(null);
  const [version, setVersion] = useState("");
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
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-2xl max-h-[80vh] flex flex-col"
        onClick={e => e.stopPropagation()}>
        <div className="p-5 border-b border-gray-100 flex items-center justify-between">
          <div>
            <h3 className="text-lg font-bold text-black">{title}</h3>
            {version && <p className="text-xs text-gray-400 mt-0.5">버전 {version}</p>}
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-2xl leading-none">×</button>
        </div>
        <div className="p-5 overflow-y-auto">
          {loading ? (
            <p className="text-sm text-gray-400">불러오는 중...</p>
          ) : body ? (
            <pre className="text-sm text-gray-700 whitespace-pre-wrap leading-relaxed font-sans">{body}</pre>
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
