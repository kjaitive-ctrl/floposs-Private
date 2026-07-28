// 회계 장부(현금흐름/손익) 데이터 레이어 (browser-direct). 마이그 218.
// 계정과목은 tenant 가 직접 만들고 관리 — 여기선 구조(전표 형태)만 제공.
// [[feedback_retail_browser_supabase_direct]]
import { supabase } from "@/lib/supabase";

export const ACCOUNT_TYPES = ["매출", "매입원가", "인건비", "판관비", "세금과공과", "자본거래"] as const;
export type AccountType = (typeof ACCOUNT_TYPES)[number];

// 손익(매출-매입원가-인건비-판관비-세금과공과)에 들어가는 타입. 자본거래(대납/가지급금 등)는 제외.
export const PNL_TYPES: AccountType[] = ["매출", "매입원가", "인건비", "판관비", "세금과공과"];

export interface AccountCategory {
  id: string;
  name: string;
  type: AccountType;
  sort_order: number;
  is_active: boolean;
}

export interface CashTransaction {
  id: string;
  txn_date: string;              // ISO "2026-07-28"
  direction: "in" | "out";
  account_category_id: string | null;
  retail_supplier_id: string | null;
  counterparty_name: string | null;
  amount: number;
  vat_included: boolean;
  supply_amount: number;
  vat_amount: number;
  memo: string | null;
  // 조인 표시용
  category?: { name: string; type: AccountType } | null;
}

// amount + 부가세포함 체크 → 공급가/부가세 계산 (매입 관행: 부가세 포함해서 입금 시 공급가=amount/1.1 반올림)
export function splitVat(amount: number, vatIncluded: boolean): { supply_amount: number; vat_amount: number } {
  if (!vatIncluded) return { supply_amount: amount, vat_amount: 0 };
  const supply = Math.round(amount / 1.1);
  return { supply_amount: supply, vat_amount: amount - supply };
}

// ── 계정과목 ──────────────────────────────
export async function loadAccountCategories(tenantId: string): Promise<AccountCategory[]> {
  const { data, error } = await supabase
    .from("account_categories")
    .select("id, name, type, sort_order, is_active")
    .eq("tenant_id", tenantId)
    .eq("is_active", true)
    .order("sort_order")
    .order("created_at");
  if (error) { console.error("loadAccountCategories:", error); return []; }
  return (data ?? []) as AccountCategory[];
}

export async function addAccountCategory(tenantId: string, name: string, type: AccountType): Promise<AccountCategory | null> {
  const { data: maxRow } = await supabase
    .from("account_categories").select("sort_order")
    .eq("tenant_id", tenantId).order("sort_order", { ascending: false }).limit(1).maybeSingle();
  const sort_order = (maxRow?.sort_order ?? 0) + 1;
  const { data, error } = await supabase
    .from("account_categories")
    .insert({ tenant_id: tenantId, name: name.trim(), type, sort_order })
    .select("id, name, type, sort_order, is_active")
    .single();
  if (error) { console.error("addAccountCategory:", error); return null; }
  return data as AccountCategory;
}

export async function renameAccountCategory(id: string, name: string): Promise<void> {
  await supabase.from("account_categories").update({ name: name.trim(), updated_at: new Date().toISOString() }).eq("id", id);
}

export async function deactivateAccountCategory(id: string): Promise<void> {
  await supabase.from("account_categories").update({ is_active: false, updated_at: new Date().toISOString() }).eq("id", id);
}

// ── 현금 거래 전표 ──────────────────────────────
export async function loadCashTransactions(tenantId: string, fromIso: string, toIso: string): Promise<CashTransaction[]> {
  const { data, error } = await supabase
    .from("cash_transactions")
    .select("id, txn_date, direction, account_category_id, retail_supplier_id, counterparty_name, amount, vat_included, supply_amount, vat_amount, memo, category:account_categories(name, type)")
    .eq("tenant_id", tenantId)
    .gte("txn_date", fromIso)
    .lte("txn_date", toIso)
    .order("txn_date", { ascending: false })
    .order("created_at", { ascending: false });
  if (error) { console.error("loadCashTransactions:", error); return []; }
  return (data ?? []).map(r => ({
    ...r,
    category: Array.isArray(r.category) ? r.category[0] ?? null : r.category,
  })) as CashTransaction[];
}

export interface CashTransactionInput {
  txn_date: string;
  direction: "in" | "out";
  account_category_id: string | null;
  retail_supplier_id: string | null;
  counterparty_name: string | null;
  amount: number;
  vat_included: boolean;
  memo: string | null;
}

export async function addCashTransaction(tenantId: string, input: CashTransactionInput): Promise<string | null> {
  const { supply_amount, vat_amount } = splitVat(input.amount, input.vat_included);
  const { data, error } = await supabase
    .from("cash_transactions")
    .insert({ tenant_id: tenantId, ...input, supply_amount, vat_amount })
    .select("id")
    .single();
  if (error) { console.error("addCashTransaction:", error); return null; }
  return data.id;
}

export async function updateCashTransaction(id: string, patch: Partial<CashTransactionInput>): Promise<boolean> {
  const next = { ...patch, updated_at: new Date().toISOString() } as Record<string, unknown>;
  if (patch.amount !== undefined || patch.vat_included !== undefined) {
    // 둘 중 하나만 바뀌어도 최신값 기준 재계산하려면 호출부가 amount+vat_included 둘 다 넘겨야 함
    if (patch.amount !== undefined && patch.vat_included !== undefined) {
      const { supply_amount, vat_amount } = splitVat(patch.amount, patch.vat_included);
      next.supply_amount = supply_amount;
      next.vat_amount = vat_amount;
    }
  }
  const { error } = await supabase.from("cash_transactions").update(next).eq("id", id);
  if (error) { console.error("updateCashTransaction:", error); return false; }
  return true;
}

export async function deleteCashTransaction(id: string): Promise<void> {
  await supabase.from("cash_transactions").delete().eq("id", id);
}

// ── 거래처 매트릭스 (ledger_parties, 마이그 219) ──────────────────────
// 월과 무관하게 영속하는 "행" — 이름/계정과목/방향/VAT관행을 한 번 정하면
// 사용자가 지울 때까지 매달 계속 뜬다. 매트릭스 셀(거래처×날짜) 하나 =
// cash_transactions 한 행 (ledger_party_id 로 링크).
export interface LedgerParty {
  id: string;
  name: string;
  retail_supplier_id: string | null;
  account_category_id: string | null;
  direction: "in" | "out";
  vat_included_default: boolean;
  bank_name: string | null;
  account_number: string | null;
  memo: string | null;
  sort_order: number;
  category?: { name: string; type: AccountType } | null;
}

const LEDGER_PARTY_COLS = "id, name, retail_supplier_id, account_category_id, direction, vat_included_default, bank_name, account_number, memo, sort_order";

export async function loadLedgerParties(tenantId: string): Promise<LedgerParty[]> {
  const { data, error } = await supabase
    .from("ledger_parties")
    .select(`${LEDGER_PARTY_COLS}, category:account_categories(name, type)`)
    .eq("tenant_id", tenantId)
    .eq("is_active", true)
    .order("sort_order")
    .order("created_at");
  if (error) { console.error("loadLedgerParties:", error); return []; }
  return (data ?? []).map(r => ({
    ...r,
    category: Array.isArray(r.category) ? r.category[0] ?? null : r.category,
  })) as LedgerParty[];
}

// 이름으로 기존 행 찾기 — 있으면 재사용(중복 방지), 없으면 null.
export async function findLedgerPartyByName(tenantId: string, name: string): Promise<LedgerParty | null> {
  const { data } = await supabase
    .from("ledger_parties")
    .select(LEDGER_PARTY_COLS)
    .eq("tenant_id", tenantId)
    .eq("name", name.trim())
    .eq("is_active", true)
    .maybeSingle();
  return data as LedgerParty | null;
}

export interface AddLedgerPartyInput {
  name: string;
  retail_supplier_id: string | null;
  account_category_id: string | null;
  direction: "in" | "out";
  vat_included_default: boolean;
  bank_name?: string | null;
  account_number?: string | null;
  memo?: string | null;
}

export async function addLedgerParty(tenantId: string, input: AddLedgerPartyInput): Promise<LedgerParty | null> {
  const { data: maxRow } = await supabase
    .from("ledger_parties").select("sort_order")
    .eq("tenant_id", tenantId).order("sort_order", { ascending: false }).limit(1).maybeSingle();
  const sort_order = (maxRow?.sort_order ?? 0) + 1;
  const { data, error } = await supabase
    .from("ledger_parties")
    .insert({ tenant_id: tenantId, ...input, name: input.name.trim(), sort_order })
    .select(LEDGER_PARTY_COLS)
    .single();
  if (error) { console.error("addLedgerParty:", error); return null; }
  return data as LedgerParty;
}

export async function updateLedgerParty(id: string, patch: Partial<AddLedgerPartyInput>): Promise<void> {
  await supabase.from("ledger_parties").update({ ...patch, updated_at: new Date().toISOString() }).eq("id", id);
}

export async function deactivateLedgerParty(id: string): Promise<void> {
  await supabase.from("ledger_parties").update({ is_active: false, updated_at: new Date().toISOString() }).eq("id", id);
}

// 선택된 달의 매트릭스 셀 값 — key: `${ledger_party_id}:${txn_date}`
export async function loadMatrixCells(tenantId: string, fromIso: string, toIso: string): Promise<Map<string, number>> {
  const { data, error } = await supabase
    .from("cash_transactions")
    .select("ledger_party_id, txn_date, amount")
    .eq("tenant_id", tenantId)
    .not("ledger_party_id", "is", null)
    .gte("txn_date", fromIso)
    .lte("txn_date", toIso);
  if (error) { console.error("loadMatrixCells:", error); return new Map(); }
  const map = new Map<string, number>();
  for (const r of data ?? []) map.set(`${r.ledger_party_id}:${r.txn_date}`, r.amount);
  return map;
}

// 셀 하나 저장 — 있으면 갱신, 없으면 새로 생성, 0/빈값이면 삭제.
// partial unique index 라 upsert(onConflict) 대신 select-then-write.
export async function setMatrixCell(tenantId: string, party: LedgerParty, dateIso: string, amount: number): Promise<boolean> {
  const { data: existing } = await supabase
    .from("cash_transactions")
    .select("id")
    .eq("ledger_party_id", party.id)
    .eq("txn_date", dateIso)
    .maybeSingle();

  if (amount <= 0) {
    if (existing) await supabase.from("cash_transactions").delete().eq("id", existing.id);
    return true;
  }

  const { supply_amount, vat_amount } = splitVat(amount, party.vat_included_default);
  const payload = {
    tenant_id: tenantId, txn_date: dateIso, direction: party.direction,
    account_category_id: party.account_category_id, retail_supplier_id: party.retail_supplier_id,
    counterparty_name: party.name, amount, vat_included: party.vat_included_default,
    supply_amount, vat_amount, ledger_party_id: party.id,
    updated_at: new Date().toISOString(),
  };
  if (existing) {
    const { error } = await supabase.from("cash_transactions").update(payload).eq("id", existing.id);
    if (error) console.error("setMatrixCell update:", error);
    return !error;
  }
  const { error } = await supabase.from("cash_transactions").insert(payload);
  if (error) console.error("setMatrixCell insert:", error);
  return !error;
}
