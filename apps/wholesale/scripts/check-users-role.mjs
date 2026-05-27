// 현재 등록된 user / tenant 상태 점검
// 누구를 super_admin 으로 승격해야 할지 판단용
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "fs";

const env = Object.fromEntries(
  readFileSync(new URL("../.env.local", import.meta.url), "utf8")
    .split("\n").filter(Boolean).map(l => l.split("="))
);
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

console.log("=== auth.users ===");
const { data: { users: authUsers } } = await sb.auth.admin.listUsers({ perPage: 1000 });
for (const u of authUsers) {
  const meta = u.app_metadata ?? {};
  console.log(`  ${u.email?.padEnd(35) ?? "(no email)"}  meta.role=${meta.role ?? "—"}  tenant=${(meta.tenant_id ?? "—").slice(0, 8)}`);
}

console.log("\n=== public.users ===");
const { data: appUsers } = await sb.from("users").select("id, email, name, role, tenant_id, retailer_id, user_type, is_active");
for (const u of appUsers ?? []) {
  console.log(`  ${(u.email ?? "—").padEnd(35)}  role=${(u.role ?? "—").padEnd(13)}  tenant=${(u.tenant_id ?? "—").slice(0, 8)}  type=${u.user_type ?? "—"}  active=${u.is_active}`);
}

console.log("\n=== tenants ===");
const { data: tenants } = await sb.from("tenants").select("id, company_name, tenant_type, is_active");
for (const t of tenants ?? []) {
  console.log(`  ${t.id.slice(0, 8)}  ${(t.company_name ?? "—").padEnd(20)}  type=${t.tenant_type}  active=${t.is_active}`);
}

console.log(`\n총 auth.users=${authUsers.length}, public.users=${(appUsers ?? []).length}, tenants=${(tenants ?? []).length}`);
