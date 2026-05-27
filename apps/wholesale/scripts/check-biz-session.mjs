import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "fs";

const env = Object.fromEntries(
  readFileSync(new URL("../.env.local", import.meta.url), "utf8")
    .split("\n").filter(Boolean).map(l => l.split("="))
);

const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);

async function checkColumn(table, column) {
  const { error } = await sb.from(table).select(column).limit(1);
  if (!error) return { table, column, exists: true };
  if (error.code === "42703" || /column .* does not exist/i.test(error.message)) {
    return { table, column, exists: false };
  }
  return { table, column, exists: "?", err: error.message };
}

async function checkTable(table) {
  const { error, count } = await sb.from(table).select("*", { count: "exact", head: true });
  if (!error) return { table, exists: true, rows: count };
  if (error.code === "42P01" || /relation .* does not exist|could not find the table/i.test(error.message)) {
    return { table, exists: false };
  }
  return { table, exists: "?", err: error.message };
}

const cols = await Promise.all([
  checkColumn("orders", "biz_session_id"),
  checkColumn("transactions", "biz_session_id"),
  checkColumn("transactions", "cash_session_id"),
  checkColumn("biz_sessions", "id"),
]);

const tables = await Promise.all([
  checkTable("biz_sessions"),
  checkTable("cash_sessions"),
  checkTable("business_session_logs"),
]);

console.log("=== 컬럼 존재 여부 ===");
for (const c of cols) console.log(`${c.table}.${c.column}:`, c.exists, c.err ?? "");

console.log("\n=== 테이블 존재 + 행 수 ===");
for (const t of tables) console.log(`${t.table}:`, t.exists, "rows:", t.rows ?? "-", t.err ?? "");

// biz_sessions / cash_sessions 샘플 1행
const { data: bs } = await sb.from("biz_sessions").select("*").limit(1);
console.log("\n=== biz_sessions 샘플 컬럼 ===");
console.log(bs?.[0] ? Object.keys(bs[0]) : "(no rows)");

const { data: cs } = await sb.from("cash_sessions").select("*").limit(1);
console.log("\n=== cash_sessions 샘플 컬럼 ===");
console.log(cs?.[0] ? Object.keys(cs[0]) : "(no rows)");

// transactions 중 biz_session_id NULL 개수
const { count: nullCount } = await sb.from("transactions")
  .select("*", { count: "exact", head: true }).is("biz_session_id", null);
const { count: totalTx } = await sb.from("transactions")
  .select("*", { count: "exact", head: true });
console.log("\n=== transactions ===");
console.log("총 행 수:", totalTx, " / biz_session_id NULL 행 수:", nullCount);

// orders 중 biz_session_id NULL 개수
const { count: nullOrders } = await sb.from("orders")
  .select("*", { count: "exact", head: true }).is("biz_session_id", null);
const { count: totalOrders } = await sb.from("orders")
  .select("*", { count: "exact", head: true });
console.log("\n=== orders ===");
console.log("총 행 수:", totalOrders, " / biz_session_id NULL 행 수:", nullOrders);
