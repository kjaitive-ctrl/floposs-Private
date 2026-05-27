// ============================================================
// 영업개시 가드 도입 전 누적된 NULL biz_session_id 데이터 정리
//
// 사용:
//   node scripts/cleanup-test-data.mjs           # dry-run
//   node scripts/cleanup-test-data.mjs --apply   # 실제 삭제
//
// 정리 대상:
//   - orders (biz_session_id NULL) + 연관 order_items (CASCADE)
//   - transactions (biz_session_id NULL) — transactions.order_item_id는 ON DELETE SET NULL
//   - biz_sessions (테스트 4초짜리 1건)
//   - 위 orders를 참조하는 shipments, production_orders (FK 위반 회피)
//   - 위 order_items를 참조하는 inventory_logs (NO ACTION FK)
//   - 위 transactions를 참조하는 vat_batch_items (CASCADE)
// ============================================================

import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "fs";

const env = Object.fromEntries(
  readFileSync(new URL("../.env.local", import.meta.url), "utf8")
    .split("\n").filter(Boolean).map(l => l.split("="))
);
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
const apply = process.argv.includes("--apply");

console.log(apply ? "=== APPLY MODE — 실제 삭제 ===\n" : "=== DRY RUN — 영향 row 수만 표시 ===\n");

// 1. NULL biz_session_id 행 ID 목록
const { data: nullOrders } = await sb.from("orders").select("id").is("biz_session_id", null);
const orderIds = (nullOrders ?? []).map(o => o.id);

const { data: nullTx } = await sb.from("transactions").select("id").is("biz_session_id", null);
const txIds = (nullTx ?? []).map(t => t.id);

const { data: bizs } = await sb.from("biz_sessions").select("id");
const bizIds = (bizs ?? []).map(b => b.id);

console.log(`orders 정리 대상       : ${orderIds.length} 건`);
console.log(`transactions 정리 대상 : ${txIds.length} 건`);
console.log(`biz_sessions 정리 대상 : ${bizIds.length} 건 (테스트 데이터 전부)`);

// 2. 연관 order_items (orders DELETE 시 CASCADE되지만 inventory_logs FK 위반 회피용)
const idStub = orderIds.length ? orderIds : ["00000000-0000-0000-0000-000000000000"];
const { data: items } = await sb.from("order_items").select("id").in("order_id", idStub);
const itemIds = (items ?? []).map(i => i.id);
const itemStub = itemIds.length ? itemIds : ["00000000-0000-0000-0000-000000000000"];

const { count: shipmentCount } = await sb.from("shipments")
  .select("*", { count: "exact", head: true }).in("order_id", idStub);

const { count: prodCount } = await sb.from("production_orders")
  .select("*", { count: "exact", head: true }).in("order_id", idStub);

const txStub = txIds.length ? txIds : ["00000000-0000-0000-0000-000000000000"];
const { count: vatItemCount } = await sb.from("vat_batch_items")
  .select("*", { count: "exact", head: true }).in("transaction_id", txStub);

const { count: invLogCount } = await sb.from("inventory_logs")
  .select("*", { count: "exact", head: true }).in("order_item_id", itemStub);

console.log(`\n부수 영향 (FK 참조):`);
console.log(`  inventory_logs    : ${invLogCount ?? 0} 건 (수동 삭제 필요, ON DELETE NO ACTION)`);
console.log(`  shipments         : ${shipmentCount ?? 0} 건  (수동 삭제 필요, ON DELETE NO ACTION)`);
console.log(`  production_orders : ${prodCount ?? 0} 건     (수동 삭제 필요, ON DELETE NO ACTION)`);
console.log(`  vat_batch_items   : ${vatItemCount ?? 0} 건    (transactions DELETE 시 CASCADE)`);

// 3. 마스터 데이터는 안 건드림 (확인용)
const { count: customers } = await sb.from("customers").select("*", { count: "exact", head: true });
const { count: products } = await sb.from("products").select("*", { count: "exact", head: true });
const { count: variants } = await sb.from("product_variants").select("*", { count: "exact", head: true });
const { count: inventory } = await sb.from("inventory").select("*", { count: "exact", head: true });

console.log(`\n보존되는 마스터 데이터 (참고용):`);
console.log(`  customers          : ${customers ?? 0} 건`);
console.log(`  products           : ${products ?? 0} 건`);
console.log(`  product_variants   : ${variants ?? 0} 건`);
console.log(`  inventory          : ${inventory ?? 0} 건`);

if (!apply) {
  console.log(`\n→ dry-run 종료. 실제 삭제하려면 --apply 옵션을 붙여 다시 실행.`);
  process.exit(0);
}

// === 실제 삭제 (FK 순서 주의) ===
console.log(`\n--- 삭제 시작 ---`);

// 1) inventory_logs (order_items 참조, NO ACTION) — orders DELETE 전에 반드시
if (invLogCount && itemIds.length) {
  const { error } = await sb.from("inventory_logs").delete().in("order_item_id", itemIds);
  if (error) { console.error("inventory_logs 삭제 실패:", error.message); process.exit(1); }
  console.log(`inventory_logs  : ${invLogCount} 건 삭제`);
}

// 2) shipments (orders 참조, NO ACTION)
if (shipmentCount && orderIds.length) {
  const { error } = await sb.from("shipments").delete().in("order_id", orderIds);
  if (error) { console.error("shipments 삭제 실패:", error.message); process.exit(1); }
  console.log(`shipments       : ${shipmentCount} 건 삭제`);
}

// 3) production_orders (orders 참조, NO ACTION)
if (prodCount && orderIds.length) {
  const { error } = await sb.from("production_orders").delete().in("order_id", orderIds);
  if (error) { console.error("production_orders 삭제 실패:", error.message); process.exit(1); }
  console.log(`production_orders: ${prodCount} 건 삭제`);
}

// 4) transactions (vat_batch_items CASCADE)
if (txIds.length) {
  const { error } = await sb.from("transactions").delete().in("id", txIds);
  if (error) { console.error("transactions 삭제 실패:", error.message); process.exit(1); }
  console.log(`transactions    : ${txIds.length} 건 삭제 (vat_batch_items CASCADE)`);
}

// 5) orders (order_items CASCADE)
if (orderIds.length) {
  const { error } = await sb.from("orders").delete().in("id", orderIds);
  if (error) { console.error("orders 삭제 실패:", error.message); process.exit(1); }
  console.log(`orders          : ${orderIds.length} 건 삭제 (order_items CASCADE)`);
}

// 6) biz_sessions (테스트 1건)
if (bizIds.length) {
  const { error } = await sb.from("biz_sessions").delete().in("id", bizIds);
  if (error) { console.error("biz_sessions 삭제 실패:", error.message); process.exit(1); }
  console.log(`biz_sessions    : ${bizIds.length} 건 삭제`);
}

console.log(`\n=== 정리 완료 ===`);
