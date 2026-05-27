import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "fs";

const env = Object.fromEntries(
  readFileSync(new URL("../.env.local", import.meta.url), "utf8")
    .split("\n").filter(Boolean).map(l => l.split("="))
);
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);

const { count: total } = await sb.from("inbound_orders").select("*", { count: "exact", head: true });
const { count: nullCnt } = await sb.from("inbound_orders").select("*", { count: "exact", head: true }).is("biz_session_id", null);
console.log(`inbound_orders 총: ${total}, biz_session_id NULL: ${nullCnt}`);

const { data: rows } = await sb.from("inbound_orders").select("id, inbound_date, total_amount, biz_session_id, created_at").order("inbound_date");
console.log("\n전체 입고:");
for (const r of rows ?? []) {
  console.log(`  ${r.inbound_date} ${r.total_amount?.toLocaleString().padStart(10) ?? "-"} biz=${r.biz_session_id?.slice(0,8) ?? "NULL"}`);
}
