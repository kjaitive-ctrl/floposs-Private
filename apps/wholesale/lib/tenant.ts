import { supabase } from "./supabase";
import { generateTenantCode } from "./orderNumber";

export type TenantInfo = { id: string; tenantCode: string; companyName: string };

export async function getTenantInfo(): Promise<TenantInfo | null> {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) return null;

  const authUser = session.user;

  const { data: existingUser } = await supabase
    .from("users")
    .select("tenant_id")
    .eq("email", authUser.email)
    .single();

  if (existingUser?.tenant_id) {
    const tenantId = existingUser.tenant_id;
    // tenant_code 별도 조회 (컬럼 없을 경우 빈 문자열 폴백)
    const { data: tenant } = await supabase
      .from("tenants")
      .select("tenant_code, company_name")
      .eq("id", tenantId)
      .single();
    const t = tenant as { tenant_code?: string; company_name?: string } | null;
    return {
      id: tenantId,
      tenantCode: t?.tenant_code ?? "",
      companyName: t?.company_name ?? "도매 POS",
    };
  }

  // 신규 테넌트 생성
  let tenantCode = generateTenantCode();

  // 중복 체크 후 발급
  while (true) {
    const { data: existing } = await supabase
      .from("tenants")
      .select("id")
      .eq("tenant_code", tenantCode)
      .maybeSingle();
    if (!existing) break;
    tenantCode = generateTenantCode();
  }

  const { data: newTenant, error: tenantError } = await supabase
    .from("tenants")
    .insert({
      tenant_type: "wholesale",
      company_name: authUser.email?.split("@")[0] || "내 업체",
      tenant_code: tenantCode,
    })
    .select("id, tenant_code")
    .single();

  if (tenantError || !newTenant) return null;

  await supabase.from("users").insert({
    tenant_id: newTenant.id,
    email: authUser.email,
    name: authUser.email?.split("@")[0] || "관리자",
    role: "tenant_admin",
  });

  return { id: newTenant.id, tenantCode: newTenant.tenant_code, companyName: authUser.email?.split("@")[0] || "도매 POS" };
}

// 하위 호환성 유지
export async function getOrCreateTenantId(): Promise<string | null> {
  const info = await getTenantInfo();
  return info?.id ?? null;
}
