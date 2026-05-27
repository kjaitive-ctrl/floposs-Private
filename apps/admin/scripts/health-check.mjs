// 운영 DB + SQL 일관성 종합 점검
import { createClient } from "@supabase/supabase-js";
import { readFileSync, readdirSync } from "fs";

const env = Object.fromEntries(
  readFileSync(new URL("../.env.local", import.meta.url), "utf8")
    .split("\n").filter(Boolean).map(l => l.split("="))
);
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);

console.log("=== 운영 DB 데이터 현황 ===");
const tables = [
  "tenants", "users", "customers", "products", "product_variants",
  "inventory", "inbound_orders", "inbound_items",
  "orders", "order_items",
  "transactions", "biz_sessions",
  "vat_batches", "vat_batch_items",
];
for (const t of tables) {
  const { count, error } = await sb.from(t).select("*", { count: "exact", head: true });
  console.log(`  ${t.padEnd(25)} : ${error ? "❌ " + error.message : (count ?? 0) + " 건"}`);
}

console.log("\n=== 폐기된 테이블 잔존 확인 ===");
for (const t of ["cash_sessions", "business_session_logs"]) {
  const { error } = await sb.from(t).select("*", { count: "exact", head: true });
  console.log(`  ${t.padEnd(25)} : ${error ? "✅ 폐기됨" : "⚠️ 아직 살아있음"}`);
}

console.log("\n=== 폐기된 컬럼 잔존 확인 ===");
{
  const { error } = await sb.from("transactions").select("cash_session_id").limit(1);
  console.log(`  transactions.cash_session_id : ${error ? "✅ 폐기됨" : "⚠️ 아직 살아있음"}`);
}

console.log("\n=== biz_session_id NOT NULL 위반 (있으면 071/072 적용 안 됨) ===");
{
  const { count: nullO } = await sb.from("orders").select("*", { count: "exact", head: true }).is("biz_session_id", null);
  const { count: nullT } = await sb.from("transactions").select("*", { count: "exact", head: true }).is("biz_session_id", null);
  console.log(`  orders.biz_session_id NULL       : ${nullO ?? 0} 건`);
  console.log(`  transactions.biz_session_id NULL : ${nullT ?? 0} 건`);
}

console.log("\n=== 동시 활성 세션 (070 partial unique index 검증) ===");
{
  const { data } = await sb.from("biz_sessions").select("tenant_id, id").eq("status", "open");
  const byTenant = {};
  for (const r of data ?? []) (byTenant[r.tenant_id] = byTenant[r.tenant_id] || []).push(r.id);
  let bad = 0;
  for (const [t, ids] of Object.entries(byTenant)) if (ids.length > 1) { console.log(`  ⚠️ tenant ${t}: ${ids.length}개 동시 open`); bad++; }
  console.log(`  ${bad === 0 ? "✅" : "❌"} 위반 ${bad} 건`);
}

console.log("\n=== Orphan / 정합성 ===");
// orders.biz_session_id가 실재 biz_sessions를 가리키는지
{
  const { data: orders } = await sb.from("orders").select("id, biz_session_id").not("biz_session_id", "is", null);
  const { data: sessions } = await sb.from("biz_sessions").select("id");
  const sids = new Set((sessions ?? []).map(s => s.id));
  const orphan = (orders ?? []).filter(o => !sids.has(o.biz_session_id));
  console.log(`  orders → biz_sessions orphan : ${orphan.length} 건 ${orphan.length === 0 ? "✅" : "⚠️"}`);
}
{
  const { data: txs } = await sb.from("transactions").select("id, biz_session_id").not("biz_session_id", "is", null);
  const { data: sessions } = await sb.from("biz_sessions").select("id");
  const sids = new Set((sessions ?? []).map(s => s.id));
  const orphan = (txs ?? []).filter(t => !sids.has(t.biz_session_id));
  console.log(`  transactions → biz_sessions orphan : ${orphan.length} 건 ${orphan.length === 0 ? "✅" : "⚠️"}`);
}

console.log("\n=== 운영 DB 측 트리거 동작 확인 ===");
// status='open' 세션이 0개일 때 INSERT 시도 → NOT NULL 거부 (072 검증)
// 일단 기존 활성 세션 있는지만 확인
{
  const { data } = await sb.from("biz_sessions").select("id").eq("status", "open").limit(1);
  console.log(`  활성 세션 : ${data && data.length ? "있음 (" + data[0].id.slice(0,8) + ")" : "없음"}`);
}

console.log("\n=== SQL 마이그레이션 파일 ===");
const files = readdirSync(new URL("../supabase", import.meta.url))
  .filter(f => f.endsWith(".sql"))
  .sort();
console.log(`  총 ${files.length} 개`);
for (const f of files) console.log(`  - ${f}`);
