"use client";

import { createContext, useContext, useEffect, useState, ReactNode } from "react";
import { usePathname } from "next/navigation";
import { supabase } from "@/lib/supabase";
import type { TenantBase } from "@/lib/types";

// TenantContext 에서 노출하는 형태 (옛 이름 유지 — 호환).
export type TenantInfo = TenantBase;

// TenantContext — 한 페이지 진입 시 /api/order-portal/me 한 번만 호출.
// NavBar + 페이지 + 기타 컴포넌트들이 같은 결과 공유 (각자 별도 fetch X).
//
// 사용 패턴:
//   layout.tsx 또는 인증 영역 root 에 <TenantProvider> 박제
//   각 컴포넌트는 useTenant() 호출 → context 의 박제값 사용

interface TenantState {
  tenant: TenantInfo | null;
  loading: boolean;
  error: string | null;
}

const Ctx = createContext<TenantState | null>(null);

// 인증 페이지에선 me 호출 skip — 무한 redirect 루프 방지 + 불필요 RTT 절감
function isAuthPage(pathname: string): boolean {
  if (pathname === "/login" || pathname === "/signup") return true;
  if (pathname === "/order" || pathname === "/order/signup") return true;
  if (pathname.startsWith("/s/")) return true;  // 전자노트 공개 보드 — 로그인 없음 (안건3 받는쪽 v1)
  return false;
}

// 구독 만료 가드 우회 경로 — 만료 안내/내정보(결제수단 등)는 만료자도 접근 가능
function isSubscriptionExemptPage(pathname: string): boolean {
  if (pathname === "/subscription-required") return true;
  if (pathname.startsWith("/dashboard/settings")) return true;
  return false;
}

// 구독 활성 여부 (wholesale lib/subscription.ts 와 동일 로직)
function isSubscriptionActive(planId: string | null, expiresAt: string | null): boolean {
  if (!planId) return false;
  if (!expiresAt) return true;  // 무제한
  return new Date(expiresAt) >= new Date();
}

export function TenantProvider({ children, redirectOnUnauth = true }: { children: ReactNode; redirectOnUnauth?: boolean }) {
  const [state, setState] = useState<TenantState>({ tenant: null, loading: true, error: null });
  const pathname = usePathname();

  useEffect(() => {
    if (isAuthPage(pathname)) {
      setState({ tenant: null, loading: false, error: null });
      return;
    }

    // 페이지 이동 직후 — 이전 상태(예: /login 의 tenant:null) 가 가드(!tenant)에 걸려
    // "조회 실패" 빨간 글씨가 깜빡이는 것 방지. 새 fetch 동안 loading 으로 리셋.
    setState(prev => ({ ...prev, loading: true, error: null }));

    let cancelled = false;
    (async () => {
      try {
        // 브라우저 → Supabase Seoul 직접 호출 — Vercel 서버 라우트 경유 X.
        // wholesale-pos 와 동일 패턴 (대륙간 hop 0).
        const { data: { user } } = await supabase.auth.getUser();
        if (cancelled) return;
        if (!user) {
          if (redirectOnUnauth && typeof window !== "undefined") {
            const loginPath = pathname.startsWith("/order") ? "/order" : "/login";
            window.location.href = `${loginPath}?redirect=${encodeURIComponent(pathname)}`;
            // 리다이렉트 진행 중 — 페이지가 에러(빨간 flash) 대신 로딩을 표시하도록 loading 유지.
            setState({ tenant: null, loading: true, error: null });
          } else {
            setState({ tenant: null, loading: false, error: "unauthenticated" });
          }
          return;
        }

        const tenantId = (user.app_metadata as { tenant_id?: string } | undefined)?.tenant_id;
        if (!tenantId) {
          setState({ tenant: null, loading: false, error: "tenant_id not set" });
          return;
        }

        const { data: tenant, error } = await supabase
          .from("tenants")
          .select("id, company_name, owner_name, phone, address, business_number, default_payment_method, plan_id, subscription_expires_at")
          .eq("id", tenantId)
          .single();
        if (cancelled) return;

        if (error || !tenant) {
          setState({ tenant: null, loading: false, error: error?.message ?? "tenant not found" });
          return;
        }

        // 마이그 189: 구독 만료 가드. 만료 시 /subscription-required 로 redirect.
        // 단 면제 경로 (/subscription-required, /dashboard/settings) 는 통과.
        const t = tenant as TenantInfo;
        if (!isSubscriptionExemptPage(pathname) &&
            !isSubscriptionActive(t.plan_id, t.subscription_expires_at)) {
          if (typeof window !== "undefined") {
            window.location.href = "/subscription-required";
            setState({ tenant: t, loading: true, error: null });  // 리다이렉트 중 — flash 방지
          } else {
            setState({ tenant: t, loading: false, error: "subscription_expired" });
          }
          return;
        }

        setState({ tenant: t, loading: false, error: null });
      } catch (e) {
        if (cancelled) return;
        setState({ tenant: null, loading: false, error: String(e) });
      }
    })();
    return () => { cancelled = true; };
  }, [pathname, redirectOnUnauth]);

  return <Ctx.Provider value={state}>{children}</Ctx.Provider>;
}

export function useTenant(): TenantState {
  const ctx = useContext(Ctx);
  // Provider 밖에서 호출 시 fallback — 로그인 페이지 등에서 useTenant 호출하면 noop
  if (!ctx) return { tenant: null, loading: false, error: null };
  return ctx;
}
