import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "fs";

const env = Object.fromEntries(
  readFileSync(new URL("../.env.local", import.meta.url), "utf8")
    .split("\n").filter(Boolean).map(l => l.split("="))
);
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);

const { data: orders } = await sb.from("orders").select("id").is("biz_session_id", null);
const orderIds = (orders ?? []).map(o => o.id);
console.log("NULL biz_session_id orders:", orderIds.length);

const { data: items } = await sb.from("order_items").select("id").in("order_id", orderIds.length ? orderIds : ["00000000-0000-0000-0000-000000000000"]);
const itemIds = (items ?? []).map(i => i.id);
console.log("연관 order_items:", itemIds.length);

const tablesToCheck = [
  "inventory_logs",
  "shipments",
  "production_orders",
  "production_items",
  "transactions",
];

for (const tbl of tablesToCheck) {
  for (const fk of ["order_id", "order_item_id"]) {
    const stub = (fk === "order_id" ? orderIds : itemIds);
    if (!stub.length) continue;
    const { count, error } = await sb.from(tbl).select("*", { count: "exact", head: true }).in(fk, stub);
    if (error && error.code === "42703") continue;
    if (error) { console.log(`${tbl}.${fk}: 에러 ${error.message}`); continue; }
    if (count > 0) console.log(`${tbl}.${fk}: ${count} 건 참조 중 ⚠️`);
  }
}

// 직접 DELETE 시도해서 에러 메시지 확인
if (orderIds.length) {
  console.log("\n--- DELETE 시도 (실제로 지움) ---");
  const { error } = await sb.from("orders").delete().in("id", orderIds.slice(0, 1));
  console.log("orders DELETE 결과:", error ? `❌ ${error.message} (code: ${error.code})` : "✅ 성공");
}
