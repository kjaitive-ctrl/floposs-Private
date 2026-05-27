// 로그인 직후 / 이미 로그인된 사용자가 /login 방문 시 공통 리다이렉트.
//   - super_admin → /admin
//   - tenant 회원(사장/직원, app_metadata.tenant_id 있음) → tenants.status 체크
//        pending  → /account-pending
//        suspended → /account-suspended
//        active   → /dashboard
//   - 그 외(retail 등) → users.user_type → account_types.dashboard_route 분기
//   - dashboard_route='__retail__' sentinel → 외부 (RETAIL_SITE_URL/dashboard)
//   - 폴백: /dashboard
import type { User } from "@supabase/supabase-js";
import { supabase } from "./supabase";

type RouterLike = { push: (path: string) => void };
type AppMeta = { role?: string; tenant_id?: string; user_type?: string };

export async function redirectAuthedUser(user: User, router: RouterLike): Promise<void> {
  const meta = (user.app_metadata ?? {}) as AppMeta;
  const role = meta.role;

  if (role === "super_admin") {
    // admin 분리 (모노레포) — super_admin 은 별도 admin 사이트 (다른 cookie sb-admin-auth).
    // wholesale 에서 로그인 시 admin 사이트로 cross-domain 이동 (admin 에서 재로그인).
    window.location.href = `${process.env.NEXT_PUBLIC_ADMIN_SITE_URL}/`;
    return;
  }

  // tenant 기반 사용자(사장/직원) — status 게이트
  if (meta.tenant_id && (role === "tenant_admin" || role === "staff")) {
    const { data: tenant } = await supabase
      .from("tenants")
      .select("status")
      .eq("id", meta.tenant_id)
      .maybeSingle();

    if (tenant?.status === "pending") {
      router.push("/account-pending");
      return;
    }
    if (tenant?.status === "suspended") {
      router.push("/account-suspended");
      return;
    }
    router.push("/dashboard");
    return;
  }

  // 그 외 — user_type 으로 분기 (retail 등)
  if (user.email) {
    const { data: userRow } = await supabase
      .from("users")
      .select("user_type")
      .eq("email", user.email)
      .maybeSingle();

    const userType = userRow?.user_type;
    if (userType) {
      const { data: at } = await supabase
        .from("account_types")
        .select("dashboard_route")
        .eq("code", userType)
        .maybeSingle();

      const route = at?.dashboard_route;
      if (route === "__retail__") {
        window.location.href = `${process.env.NEXT_PUBLIC_RETAIL_SITE_URL}/dashboard`;
        return;
      }
      if (route) {
        router.push(route);
        return;
      }
    }
  }

  router.push("/dashboard");
}
