import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "fs";

const env = Object.fromEntries(
  readFileSync(new URL("../.env.local", import.meta.url), "utf8")
    .split("\n").filter(Boolean).map(l => l.split("="))
);
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);

const { data: biz } = await sb.from("biz_sessions").select("*").order("opened_at");
console.log("=== biz_sessions 전체 ===");
console.log(biz);

const { data: cash } = await sb.from("cash_sessions").select("*").order("session_date");
console.log("\n=== cash_sessions 전체 ===");
console.log(cash);

const { data: logs } = await sb.from("business_session_logs").select("*").order("created_at");
console.log("\n=== business_session_logs 전체 ===");
console.log(logs);

const { data: oldestTx } = await sb.from("transactions")
  .select("id, type, amount, created_at, biz_session_id")
  .order("created_at").limit(1);
const { data: latestTx } = await sb.from("transactions")
  .select("id, type, amount, created_at, biz_session_id")
  .order("created_at", { ascending: false }).limit(1);
console.log("\n=== transactions 시간 범위 ===");
console.log("oldest:", oldestTx?.[0]);
console.log("latest:", latestTx?.[0]);

const { data: oldestOrder } = await sb.from("orders")
  .select("id, order_number, total_amount, created_at, biz_session_id")
  .order("created_at").limit(1);
const { data: latestOrder } = await sb.from("orders")
  .select("id, order_number, total_amount, created_at, biz_session_id")
  .order("created_at", { ascending: false }).limit(1);
console.log("\n=== orders 시간 범위 ===");
console.log("oldest:", oldestOrder?.[0]);
console.log("latest:", latestOrder?.[0]);

// biz_sessions 활성 세션 시간 안에 들어간 거래 있는지
if (biz?.length) {
  for (const s of biz) {
    const range = s.closed_at
      ? sb.from("orders").select("*", { count: "exact", head: true })
          .gte("created_at", s.opened_at).lte("created_at", s.closed_at)
      : sb.from("orders").select("*", { count: "exact", head: true })
          .gte("created_at", s.opened_at);
    const { count } = await range;
    console.log(`session ${s.id.slice(0,8)} (${s.status}, ${s.opened_at} ~ ${s.closed_at ?? "open"}): orders 시간대 일치=${count}`);
  }
}
