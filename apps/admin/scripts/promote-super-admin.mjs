// 특정 이메일을 super_admin 으로 승격
// 실행: node scripts/promote-super-admin.mjs <email>
//
// 동작:
//   1. public.users.role = 'super_admin' 으로 UPDATE
//   2. auth.users.app_metadata 에 role=super_admin 박기 (JWT claim)
//   3. 다음 로그인부터 즉시 super_admin 권한 적용
//
// 주의: super_admin 은 우리 회사 운영자 전용. self-service signup 으로 만들면 안 됨.
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "fs";

const email = process.argv[2];
if (!email) {
  console.error("사용법: node scripts/promote-super-admin.mjs <email>");
  process.exit(1);
}

const env = Object.fromEntries(
  readFileSync(new URL("../.env.local", import.meta.url), "utf8")
    .split("\n").filter(Boolean).map(l => l.split("="))
);
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

console.log(`=== ${email} → super_admin 승격 ===\n`);

// 1) public.users 조회
const { data: appUser, error: appErr } = await sb
  .from("users")
  .select("id, email, role, tenant_id")
  .eq("email", email)
  .maybeSingle();

if (appErr) { console.error("public.users 조회 실패:", appErr.message); process.exit(1); }
if (!appUser) { console.error(`public.users 에 ${email} 없음`); process.exit(1); }

console.log(`현재  : role=${appUser.role}  tenant=${(appUser.tenant_id ?? "—").slice(0, 8)}`);

// 2) public.users.role 업데이트
if (appUser.role !== "super_admin") {
  const { error } = await sb.from("users").update({ role: "super_admin" }).eq("id", appUser.id);
  if (error) { console.error("public.users 업데이트 실패:", error.message); process.exit(1); }
  console.log(`✓ public.users.role → super_admin`);
} else {
  console.log(`  public.users.role 이미 super_admin`);
}

// 3) auth.users 찾기
const { data: { users: authUsers } } = await sb.auth.admin.listUsers({ perPage: 1000 });
const authUser = authUsers.find(u => u.email === email);
if (!authUser) { console.error(`auth.users 에 ${email} 없음`); process.exit(1); }

// 4) app_metadata 업데이트
const newMeta = {
  ...(authUser.app_metadata ?? {}),
  role: "super_admin",
  ...(appUser.tenant_id ? { tenant_id: appUser.tenant_id } : {}),
};

const { error: metaErr } = await sb.auth.admin.updateUserById(authUser.id, {
  app_metadata: newMeta,
});
if (metaErr) { console.error("app_metadata 업데이트 실패:", metaErr.message); process.exit(1); }

console.log(`✓ auth.users.app_metadata.role → super_admin`);
console.log(`\n다음 로그인부터 /admin 으로 자동 진입합니다.`);
console.log(`현재 로그인된 세션은 로그아웃 후 재로그인하거나 1시간 (JWT 만료) 대기.`);
