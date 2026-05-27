// 기존 가입자(app_metadata 비어있음)의 auth.users 에 role / tenant_id 백필
// 1회성 스크립트 — BASE 권한 체계 도입 직후 한 번만 실행
//
// 실행: node scripts/backfill-app-metadata.mjs
//
// 동작:
//   1. public.users 전체 조회 (email/role/tenant_id)
//   2. auth.users 전체 조회
//   3. email 매칭 → app_metadata.role, app_metadata.tenant_id 채움
//   4. 이미 채워져 있으면 스킵 (idempotent)
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "fs";

const env = Object.fromEntries(
  readFileSync(new URL("../.env.local", import.meta.url), "utf8")
    .split("\n").filter(Boolean).map(l => l.split("="))
);
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

console.log("=== app_metadata 백필 시작 ===\n");

// 1) public.users 조회
const { data: appUsers, error: appErr } = await sb
  .from("users")
  .select("id, email, role, tenant_id, retailer_id, user_type");
if (appErr) {
  console.error("public.users 조회 실패:", appErr.message);
  process.exit(1);
}
console.log(`public.users : ${appUsers.length} 건`);

// 2) auth.users 조회 (페이지네이션)
const allAuthUsers = [];
let page = 1;
while (true) {
  const { data, error } = await sb.auth.admin.listUsers({ page, perPage: 1000 });
  if (error) { console.error("auth.users 조회 실패:", error.message); process.exit(1); }
  allAuthUsers.push(...data.users);
  if (data.users.length < 1000) break;
  page++;
}
console.log(`auth.users   : ${allAuthUsers.length} 건\n`);

// 3) email 매칭 → 백필
let updated = 0, skipped = 0, missing = 0;

for (const au of allAuthUsers) {
  const appUser = appUsers.find(u => u.email === au.email);
  if (!appUser) {
    console.log(`  ⚠ ${au.email} : public.users 에 매칭 행 없음 — 스킵`);
    missing++;
    continue;
  }

  const currentMeta = au.app_metadata ?? {};
  const desiredRole = appUser.role ?? null;
  const desiredTenantId = appUser.tenant_id ?? null;

  // 이미 동일하면 스킵
  if (currentMeta.role === desiredRole && currentMeta.tenant_id === desiredTenantId) {
    skipped++;
    continue;
  }

  const newMeta = { ...currentMeta };
  if (desiredRole) newMeta.role = desiredRole;
  if (desiredTenantId) newMeta.tenant_id = desiredTenantId;

  const { error: updErr } = await sb.auth.admin.updateUserById(au.id, {
    app_metadata: newMeta,
  });
  if (updErr) {
    console.log(`  ✗ ${au.email} : 업데이트 실패 — ${updErr.message}`);
    continue;
  }

  console.log(`  ✓ ${au.email}  →  role=${desiredRole}, tenant_id=${desiredTenantId ? desiredTenantId.slice(0, 8) + "…" : "—"}`);
  updated++;
}

console.log(`\n=== 결과 ===`);
console.log(`  업데이트 : ${updated}`);
console.log(`  스킵     : ${skipped} (이미 동일)`);
console.log(`  매칭없음 : ${missing}`);
console.log(`\n⚠ 백필 후 모든 사용자는 다음 로그인 시 새 JWT 를 받습니다.`);
console.log(`   현재 로그인 중인 세션은 기존 JWT 만료 (기본 1시간) 또는 재로그인 후 권한 적용됩니다.`);
