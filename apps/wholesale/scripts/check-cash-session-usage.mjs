import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "fs";

const env = Object.fromEntries(
  readFileSync(new URL("../.env.local", import.meta.url), "utf8")
    .split("\n").filter(Boolean).map(l => l.split("="))
);
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);

const { count: notNull } = await sb.from("transactions")
  .select("*", { count: "exact", head: true }).not("cash_session_id", "is", null);
const { count: total } = await sb.from("transactions")
  .select("*", { count: "exact", head: true });
console.log("transactions 총:", total, " / cash_session_id NOT NULL:", notNull);

const { data: sample } = await sb.from("transactions")
  .select("id, type, amount, created_at, cash_session_id")
  .not("cash_session_id", "is", null).limit(3);
console.log("NOT NULL 샘플:", sample);
