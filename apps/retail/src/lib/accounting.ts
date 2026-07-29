// 회계 — 입출금 매트릭스 데이터 레이어 (browser-direct). 마이그 225.
// 셀(거래처×날짜) 하나 = cash_entries 한 행 = 통장 숫자 그대로(분해 없음).
// DB 트리거가 자동으로 단순 2줄 전표(journal_entries/lines)를 생성 —
// 부가세/원천징수 같은 실제 분개는 전표 화면에서 라인을 직접 고치는
// "후처리"로 처리(이번 라운드 스코프 밖, 입출금 매트릭스가 먼저).
// [[feedback_retail_browser_supabase_direct]]
import { supabase } from "@/lib/supabase";

// 진단용 — 회계 테이블이 실제로 존재/접근 가능한지 가벼운 프로브. 마이그 225 적용 여부 확인용.
export async function checkAccountingReady(): Promise<string | null> {
  const { error } = await supabase.from("cash_line_items").select("id").limit(1);
  return error ? error.message : null;
}

export const GUBUN_LIST = ["자산", "부채", "자본", "수익", "비용"] as const;
export type Gubun = (typeof GUBUN_LIST)[number];

export interface Account {
  id: string;
  code: number;
  name: string;
  gubun: Gubun;
  is_system: boolean;
}

export interface Counterparty {
  id: string;
  name: string;
  account_holder: string | null;
  bank_name: string | null;
  account_number: string | null;
  memo: string | null;
}

export interface CashLineItem {
  id: string;
  direction: "in" | "out";
  account_id: string | null;
  counterparty_id: string | null;
  management_tag: string | null;
  memo: string | null;
  sort_order: number;
  account?: Pick<Account, "code" | "name" | "gubun"> | null;
  counterparty?: Counterparty | null;
}

// ── 계정과목 ──────────────────────────────
export async function loadAccounts(tenantId: string, opts?: { includeSystem?: boolean }): Promise<Account[]> {
  let q = supabase.from("accounts").select("id, code, name, gubun, is_system")
    .eq("tenant_id", tenantId).eq("is_active", true);
  if (!opts?.includeSystem) q = q.eq("is_system", false);
  const { data, error } = await q.order("code");
  if (error) { console.error("loadAccounts:", error); return []; }
  return (data ?? []) as Account[];
}

export async function findAccountByName(tenantId: string, name: string): Promise<Account | null> {
  const { data } = await supabase.from("accounts").select("id, code, name, gubun, is_system")
    .eq("tenant_id", tenantId).eq("name", name.trim()).eq("is_active", true).maybeSingle();
  return data as Account | null;
}

export async function addAccount(tenantId: string, name: string, gubun: Gubun): Promise<Account | null> {
  const { data, error } = await supabase.from("accounts")
    .insert({ tenant_id: tenantId, name: name.trim(), gubun })
    .select("id, code, name, gubun, is_system")
    .single();
  if (error) { console.error("addAccount:", error); return null; }
  return data as Account;
}

export async function deactivateAccount(id: string): Promise<void> {
  await supabase.from("accounts").update({ is_active: false, updated_at: new Date().toISOString() }).eq("id", id);
}

// ── 거래처 ──────────────────────────────
export async function loadCounterparties(tenantId: string): Promise<Counterparty[]> {
  const { data, error } = await supabase.from("counterparties")
    .select("id, name, account_holder, bank_name, account_number, memo")
    .eq("tenant_id", tenantId).eq("is_active", true).order("name");
  if (error) { console.error("loadCounterparties:", error); return []; }
  return (data ?? []) as Counterparty[];
}

export async function findCounterpartyByName(tenantId: string, name: string): Promise<Counterparty | null> {
  const { data } = await supabase.from("counterparties")
    .select("id, name, account_holder, bank_name, account_number, memo")
    .eq("tenant_id", tenantId).eq("name", name.trim()).eq("is_active", true).maybeSingle();
  return data as Counterparty | null;
}

export async function addCounterparty(tenantId: string, name: string): Promise<Counterparty | null> {
  const { data, error } = await supabase.from("counterparties")
    .insert({ tenant_id: tenantId, name: name.trim() })
    .select("id, name, account_holder, bank_name, account_number, memo")
    .single();
  if (error) { console.error("addCounterparty:", error); return null; }
  return data as Counterparty;
}

export async function updateCounterparty(id: string, patch: Partial<Omit<Counterparty, "id">>): Promise<void> {
  await supabase.from("counterparties").update({ ...patch, updated_at: new Date().toISOString() }).eq("id", id);
}

// ── 매트릭스 행 (cash_line_items) ──────────────────────────────
const LINE_ITEM_COLS = "id, direction, account_id, counterparty_id, management_tag, memo, sort_order";

export async function loadCashLineItems(tenantId: string): Promise<CashLineItem[]> {
  const { data, error } = await supabase.from("cash_line_items")
    .select(`${LINE_ITEM_COLS}, account:accounts(code, name, gubun), counterparty:counterparties(id, name, account_holder, bank_name, account_number, memo)`)
    .eq("tenant_id", tenantId).eq("is_active", true)
    .order("sort_order").order("created_at");
  if (error) { console.error("loadCashLineItems:", error); return []; }
  return (data ?? []).map(r => ({
    ...r,
    account: Array.isArray(r.account) ? r.account[0] ?? null : r.account,
    counterparty: Array.isArray(r.counterparty) ? r.counterparty[0] ?? null : r.counterparty,
  })) as CashLineItem[];
}

export interface AddLineItemInput {
  direction: "in" | "out";
  account_id: string | null;
  counterparty_id: string | null;
  management_tag: string | null;
  memo: string;
}

export async function addCashLineItem(tenantId: string, input: AddLineItemInput): Promise<CashLineItem | null> {
  const { data: maxRow } = await supabase.from("cash_line_items").select("sort_order")
    .eq("tenant_id", tenantId).order("sort_order", { ascending: false }).limit(1).maybeSingle();
  const sort_order = (maxRow?.sort_order ?? 0) + 1;
  const { data, error } = await supabase.from("cash_line_items")
    .insert({ tenant_id: tenantId, ...input, sort_order })
    .select(LINE_ITEM_COLS)
    .single();
  if (error) { console.error("addCashLineItem:", error); return null; }
  return data as CashLineItem;
}

// 빈 행 여러 개를 한 번에 생성 — 전부 비워둔 채로, 그 자리에서 바로 채워 넣는 방식.
// Enter로 한 줄씩 만드는 것보다 편함(한글 IME Enter 이슈도 회피).
export async function addBlankLineItems(tenantId: string, direction: "in" | "out", count: number): Promise<{ items: CashLineItem[]; error: string | null }> {
  const { data: maxRow, error: maxErr } = await supabase.from("cash_line_items").select("sort_order")
    .eq("tenant_id", tenantId).order("sort_order", { ascending: false }).limit(1).maybeSingle();
  if (maxErr) { console.error("addBlankLineItems (sort_order lookup):", maxErr); return { items: [], error: maxErr.message }; }
  let sort_order = maxRow?.sort_order ?? 0;
  const rows = Array.from({ length: count }, () => ({ tenant_id: tenantId, direction, sort_order: ++sort_order }));
  const { data, error } = await supabase.from("cash_line_items").insert(rows).select(LINE_ITEM_COLS);
  if (error) { console.error("addBlankLineItems:", error); return { items: [], error: error.message }; }
  return { items: (data ?? []) as CashLineItem[], error: null };
}

export async function updateCashLineItem(id: string, patch: Partial<AddLineItemInput>): Promise<void> {
  await supabase.from("cash_line_items").update({ ...patch, updated_at: new Date().toISOString() }).eq("id", id);
}

export async function deactivateCashLineItem(id: string): Promise<void> {
  await supabase.from("cash_line_items").update({ is_active: false, updated_at: new Date().toISOString() }).eq("id", id);
}

// ── 매트릭스 셀 (cash_entries, 통장 숫자 그대로) ──────────────────────
export async function loadCashEntries(tenantId: string, fromIso: string, toIso: string): Promise<Map<string, number>> {
  const { data, error } = await supabase.from("cash_entries")
    .select("line_item_id, txn_date, amount")
    .eq("tenant_id", tenantId).gte("txn_date", fromIso).lte("txn_date", toIso);
  if (error) { console.error("loadCashEntries:", error); return new Map(); }
  const map = new Map<string, number>();
  for (const r of data ?? []) map.set(`${r.line_item_id}:${r.txn_date}`, r.amount);
  return map;
}

// 있으면 갱신, 없으면 생성, 0이면 삭제. 음수는 허용(반제/환입 전표 — DB 트리거가 방향을 뒤집어 처리).
export async function setCashEntry(tenantId: string, lineItemId: string, txnDate: string, amount: number): Promise<boolean> {
  const { data: existing } = await supabase.from("cash_entries").select("id")
    .eq("line_item_id", lineItemId).eq("txn_date", txnDate).maybeSingle();

  if (amount === 0) {
    if (existing) await supabase.from("cash_entries").delete().eq("id", existing.id);
    return true;
  }
  if (existing) {
    const { error } = await supabase.from("cash_entries")
      .update({ amount, updated_at: new Date().toISOString() }).eq("id", existing.id);
    if (error) console.error("setCashEntry update:", error);
    return !error;
  }
  const { error } = await supabase.from("cash_entries")
    .insert({ tenant_id: tenantId, line_item_id: lineItemId, txn_date: txnDate, amount });
  if (error) console.error("setCashEntry insert:", error);
  return !error;
}

// ── 통장 기준잔액 (cash_balance_anchors, 마이그 226) ──────────────────
// 특정 날짜의 실제 통장 잔액 하나만 저장 — 이후 모든 날의 기초/기말잔액은
// 이 기준점 + cash_entries 순증감 누적으로 매번 다시 계산(고정 저장 X).
export interface CashBalanceAnchor { as_of_date: string; amount: number }

export async function loadCashBalanceAnchor(tenantId: string): Promise<CashBalanceAnchor | null> {
  const { data } = await supabase.from("cash_balance_anchors")
    .select("as_of_date, amount").eq("tenant_id", tenantId).maybeSingle();
  return data as CashBalanceAnchor | null;
}

export async function setCashBalanceAnchor(tenantId: string, asOfDate: string, amount: number): Promise<void> {
  await supabase.from("cash_balance_anchors")
    .upsert({ tenant_id: tenantId, as_of_date: asOfDate, amount, updated_at: new Date().toISOString() }, { onConflict: "tenant_id" });
}

// 기준일(제외) 초과 ~ toIso(포함) 사이 순증감(입금-출금) 합계. direction 은 line_item 을 통해 조인.
export async function loadNetCashDelta(tenantId: string, fromIsoExclusive: string, toIsoInclusive: string): Promise<number> {
  if (fromIsoExclusive >= toIsoInclusive) return 0;
  const { data, error } = await supabase.from("cash_entries")
    .select("amount, line_item:cash_line_items(direction)")
    .eq("tenant_id", tenantId).gt("txn_date", fromIsoExclusive).lte("txn_date", toIsoInclusive);
  if (error) { console.error("loadNetCashDelta:", error); return 0; }
  return (data ?? []).reduce((s, r) => {
    const li = Array.isArray(r.line_item) ? r.line_item[0] : r.line_item;
    return s + (li?.direction === "in" ? r.amount : -r.amount);
  }, 0);
}
