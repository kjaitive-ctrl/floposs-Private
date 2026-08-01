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

// 9분류(유동/비유동 구분 등, 한국 전산회계 관행) — 마이그 230.
export const GUBUN_LIST = [
  "유동자산", "비유동자산", "유동부채", "비유동부채", "자본", "매출", "매출원가", "판관비", "영업외손익",
] as const;
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

export const VAT_TYPES = ["과세", "영세", "면세"] as const;
export type VatType = (typeof VAT_TYPES)[number];

export interface CashLineItem {
  id: string;
  direction: "in" | "out";
  account_id: string | null;
  counterparty_id: string | null;
  management_tag: string | null;
  memo: string | null;
  vat_type: VatType | null;
  sort_order: number;
  account?: Pick<Account, "code" | "name" | "gubun"> | null;
  counterparty?: Counterparty | null;
}

// 매트릭스와 전표 화면이 같은 달을 공유하도록 앵커 계산을 한 곳에 둠.
export function monthRange(anchor: Date): { fromIso: string; toIso: string; label: string; days: number[] } {
  const y = anchor.getFullYear(), m = anchor.getMonth();
  const lastDay = new Date(y, m + 1, 0).getDate();
  const iso = (d: number) => `${y}-${String(m + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  return { fromIso: iso(1), toIso: iso(lastDay), label: `${y}년 ${m + 1}월`, days: Array.from({ length: lastDay }, (_, i) => i + 1) };
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

export async function updateAccount(id: string, patch: Partial<{ name: string; gubun: Gubun }>): Promise<{ error: string | null }> {
  const { error } = await supabase.from("accounts").update({ ...patch, updated_at: new Date().toISOString() }).eq("id", id);
  if (error) { console.error("updateAccount:", error); return { error: error.message }; }
  return { error: null };
}

// 표준 계정과목(9분류) 시딩 — 세팅탭 "표준 계정과목 불러오기" 버튼. 이름 겹치면
// 건너뛰므로(마이그 230, ON CONFLICT DO NOTHING) 몇 번을 눌러도 안전.
export async function seedStandardAccounts(tenantId: string): Promise<{ added: number; error: string | null }> {
  const { data, error } = await supabase.rpc("seed_standard_accounts", { p_tenant_id: tenantId });
  if (error) { console.error("seedStandardAccounts:", error); return { added: 0, error: error.message }; }
  return { added: (data as number) ?? 0, error: null };
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

// 소프트 삭제 — 목록/자동완성에서만 빠짐. 이미 연결된 행의 숫자는 그대로 남음(통장 대조로 나중에 다시 맞춤).
export async function deactivateCounterparty(id: string): Promise<void> {
  await supabase.from("counterparties").update({ is_active: false, updated_at: new Date().toISOString() }).eq("id", id);
}

// ── 매트릭스 행 (cash_line_items) ──────────────────────────────
const LINE_ITEM_COLS = "id, direction, account_id, counterparty_id, management_tag, memo, vat_type, sort_order";

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
  vat_type: VatType | null;
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

// 소프트 삭제 — 목록에서만 빠짐. 행은 월과 무관하게 영속(이월)이라 완전 삭제하면
// 이 항목에 걸린 과거 달 cash_entries/전표까지 FK CASCADE 로 같이 사라짐.
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
  // 화면 셀 키는 "id:일자숫자"(예: "abc:1") 인데 txn_date 는 전체 날짜 문자열("2026-08-01")
  // 이라 그대로 쓰면 절대 안 맞음 — 그래서 DB엔 저장됐는데 새로고침하면 화면에 안 보이던 버그.
  for (const r of data ?? []) map.set(`${r.line_item_id}:${Number(r.txn_date.slice(-2))}`, r.amount);
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

// ── 전표 (journal_entries/lines, 마이그 225/229) ──────────────────────
// 입출금 매트릭스에서 자동생성된 것(source_cash_entry_id 있음, 읽기 위주) +
// 현금 흐름 없는 계상을 위해 수동으로 만든 것(source_cash_entry_id 없음)이
// 한 화면(같은 목록)에 같이 보임.
export interface JournalLine {
  id: string;
  account_id: string;
  counterparty_id: string | null;
  debit_amount: number;
  credit_amount: number;
  sort_order: number;
  account: Pick<Account, "code" | "name" | "gubun"> | null;
  counterparty: Pick<Counterparty, "id" | "name"> | null;
}

export interface JournalEntry {
  id: string;
  entry_no: number;
  entry_date: string;
  memo: string | null;
  is_finalized: boolean;
  source_cash_entry_id: string | null;
  lines: JournalLine[];
}

export async function loadJournalEntries(tenantId: string, fromIso: string, toIso: string): Promise<JournalEntry[]> {
  const { data, error } = await supabase.from("journal_entries")
    .select(`id, entry_no, entry_date, memo, is_finalized, source_cash_entry_id,
      lines:journal_lines(id, account_id, counterparty_id, debit_amount, credit_amount, sort_order,
        account:accounts(code, name, gubun), counterparty:counterparties(id, name))`)
    .eq("tenant_id", tenantId).gte("entry_date", fromIso).lte("entry_date", toIso)
    .order("entry_date").order("entry_no");
  if (error) { console.error("loadJournalEntries:", error); return []; }
  return (data ?? []).map(r => ({
    ...r,
    lines: (r.lines ?? [])
      .map((l) => ({
        ...l,
        account: Array.isArray(l.account) ? l.account[0] ?? null : l.account,
        counterparty: Array.isArray(l.counterparty) ? l.counterparty[0] ?? null : l.counterparty,
      }))
      .sort((a, b) => a.sort_order - b.sort_order),
  })) as JournalEntry[];
}

export interface ManualJournalLineInput {
  account_id: string;
  counterparty_id: string | null;
  debit_amount: number;
  credit_amount: number;
}

// 서버(RPC)가 차변/대변 합계 일치를 검증 — 브라우저 직통이라 클라 검증만으론
// 정합성이 보장 안 됨. 잔액 안 맞으면 RPC가 에러를 던짐.
export async function createManualJournalEntry(
  tenantId: string, entryDate: string, memo: string, lines: ManualJournalLineInput[],
): Promise<{ id: string | null; error: string | null }> {
  const { data, error } = await supabase.rpc("create_manual_journal_entry", {
    p_tenant_id: tenantId, p_entry_date: entryDate, p_memo: memo, p_lines: lines,
  });
  if (error) { console.error("createManualJournalEntry:", error); return { id: null, error: error.message }; }
  return { id: data as string, error: null };
}

// 자동생성 전표(source_cash_entry_id 있음)는 이 경로로 못 지움 — 그건 입출금 셀 쪽에서 관리.
export async function deleteManualJournalEntry(id: string): Promise<{ error: string | null }> {
  const { error } = await supabase.from("journal_entries").delete().eq("id", id).is("source_cash_entry_id", null);
  if (error) { console.error("deleteManualJournalEntry:", error); return { error: error.message }; }
  return { error: null };
}
