"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase";
import { isSubscriptionActive } from "@/lib/subscription";
import { bizReset } from "@/lib/bizSession";

type Plan = {
  id: string;
  name: string;
  description: string | null;
  price: number;
  billing_cycle: string;
  features: string[] | null;
  sort_order: number;
};

const TRIAL_DAYS = 30;

function billingLabel(cycle: string) {
  if (cycle === "monthly") return "월";
  if (cycle === "yearly")  return "년";
  return cycle;
}

function trialEndDate() {
  const d = new Date();
  d.setDate(d.getDate() + TRIAL_DAYS);
  return d.toISOString().slice(0, 10);
}

export default function SubscriptionRequiredPage() {
  const router = useRouter();
  const [companyName, setCompanyName] = useState<string>("");
  const [contactEmail, setContactEmail] = useState<string>("");
  const [reason, setReason] = useState<"none" | "expired">("none");
  const [expiresAt, setExpiresAt] = useState<string>("");
  const [tenantId, setTenantId] = useState<string>("");
  const [plans, setPlans] = useState<Plan[]>([]);
  const [loadingPlans, setLoadingPlans] = useState(true);
  const [activatingId, setActivatingId] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) {
        router.push("/login");
        return;
      }
      const tid = (user.app_metadata as { tenant_id?: string })?.tenant_id ?? "";
      if (tid) {
        setTenantId(tid);
        const { data } = await supabase
          .from("tenants")
          .select("company_name, plan_id, subscription_expires_at")
          .eq("id", tid)
          .maybeSingle();
        if (data && isSubscriptionActive(data.plan_id, data.subscription_expires_at)) {
          router.push("/dashboard");
          return;
        }
        if (data?.company_name) setCompanyName(data.company_name);
        if (data?.subscription_expires_at) {
          setReason("expired");
          setExpiresAt(data.subscription_expires_at);
        } else {
          setReason("none");
        }
      }

      const [{ data: settings }, { data: planData }] = await Promise.all([
        supabase.from("platform_settings").select("contact_email").eq("id", 1).maybeSingle(),
        supabase
          .from("subscription_plans")
          .select("id, name, description, price, billing_cycle, features, sort_order")
          .eq("is_active", true)
          .order("sort_order"),
      ]);
      if (settings?.contact_email) setContactEmail(settings.contact_email);
      setPlans((planData ?? []) as Plan[]);
      setLoadingPlans(false);
    })();
  }, [router]);

  async function handleSelectPlan(plan: Plan) {
    if (!tenantId) return;
    if (!confirm(
      `[${plan.name}] 플랜으로 시작하시겠습니까?\n\n` +
      `결제 시스템 연동 전이라 ${TRIAL_DAYS}일 무료 체험으로 바로 활성화됩니다.\n` +
      `이후 결제 안내가 별도로 진행됩니다.`
    )) return;

    setActivatingId(plan.id);
    const { error } = await supabase
      .from("tenants")
      .update({
        plan_id: plan.id,
        subscription_expires_at: trialEndDate(),
      })
      .eq("id", tenantId);

    if (error) {
      alert("활성화 실패: " + error.message);
      setActivatingId(null);
      return;
    }
    router.push("/dashboard");
  }

  async function handleLogout() {
    bizReset();
    await supabase.auth.signOut();
    router.push("/login");
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-gray-50 to-gray-100 px-4 py-10">
      <div className="w-full max-w-3xl">
        <div className="bg-white rounded-2xl shadow-lg border border-gray-100 p-8 md:p-10">

          {/* 헤더 */}
          <div className="text-center mb-8">
            <div className="w-14 h-14 mx-auto rounded-full bg-primary-soft flex items-center justify-center mb-4">
              <span className="text-2xl">💳</span>
            </div>
            <h1 className="text-xl font-bold text-gray-900 mb-2">
              {reason === "expired" ? "구독이 만료되었습니다" : "구독 플랜 선택"}
            </h1>
            {companyName && (
              <p className="text-sm text-gray-600 mb-1">
                <span className="font-medium">{companyName}</span>
              </p>
            )}
            <p className="text-sm text-gray-500 leading-relaxed">
              {reason === "expired" ? (
                <>
                  {expiresAt && <>만료일: {expiresAt} · </>}
                  플랜을 다시 선택해 주세요.
                </>
              ) : (
                <>서비스 이용을 위한 플랜을 선택해 주세요.</>
              )}
            </p>
          </div>

          {/* 플랜 카드 */}
          {loadingPlans ? (
            <p className="text-center text-sm text-gray-400 py-10">플랜을 불러오는 중...</p>
          ) : plans.length === 0 ? (
            <p className="text-center text-sm text-gray-400 py-10">
              등록된 플랜이 없습니다.
              {contactEmail && <><br />문의: {contactEmail}</>}
            </p>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              {plans.map(p => {
                const features = Array.isArray(p.features) ? p.features : [];
                const activating = activatingId === p.id;
                return (
                  <div
                    key={p.id}
                    className="border border-gray-200 rounded-xl p-5 flex flex-col hover:border-primary transition-colors"
                  >
                    <div className="mb-3">
                      <h3 className="text-base font-bold text-gray-900">{p.name}</h3>
                      {p.description && (
                        <p className="text-xs text-gray-500 mt-0.5">{p.description}</p>
                      )}
                    </div>
                    <div className="mb-4">
                      <span className="text-2xl font-bold text-gray-900">
                        ₩{p.price.toLocaleString()}
                      </span>
                      <span className="text-xs text-gray-500 ml-1">/ {billingLabel(p.billing_cycle)}</span>
                    </div>
                    {features.length > 0 && (
                      <ul className="text-xs text-gray-600 space-y-1 mb-5 flex-1">
                        {features.map(f => (
                          <li key={f} className="flex items-start gap-1.5">
                            <span className="text-primary mt-0.5">✓</span>
                            <span>{f}</span>
                          </li>
                        ))}
                      </ul>
                    )}
                    <button
                      onClick={() => handleSelectPlan(p)}
                      disabled={activating || !!activatingId}
                      className="w-full py-2.5 bg-primary text-white text-sm font-medium rounded-lg hover:bg-primary-hover disabled:opacity-50 transition-colors"
                    >
                      {activating ? "활성화 중..." : "이 플랜으로 시작"}
                    </button>
                  </div>
                );
              })}
            </div>
          )}

          {/* 결제 미연동 안내 */}
          {plans.length > 0 && (
            <div className="mt-6 p-3 bg-yellow-50 border border-yellow-200 rounded-lg text-xs text-yellow-800">
              <p className="font-semibold mb-0.5">📌 결제 시스템 연동 전</p>
              <p className="text-yellow-700">
                선택 즉시 <b>{TRIAL_DAYS}일 무료 체험</b> 으로 활성화됩니다.
                정식 결제 안내는 추후 별도 진행됩니다.
              </p>
            </div>
          )}

          {contactEmail && (
            <p className="mt-6 text-center text-xs text-gray-500">
              문의: <a href={`mailto:${contactEmail}`} className="text-primary hover:underline">{contactEmail}</a>
            </p>
          )}

          <div className="text-center">
            <button onClick={handleLogout}
              className="mt-4 text-xs text-gray-400 hover:text-gray-600">
              로그아웃
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
