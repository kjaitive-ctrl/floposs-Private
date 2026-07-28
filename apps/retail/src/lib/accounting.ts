// 회계 장부(현금흐름/손익) 데이터 레이어 (browser-direct). 마이그 218.
// 계정과목은 tenant 가 직접 만들고 관리 — 여기선 구조(전표 형태)만 제공.
// [[feedback_retail_browser_supabase_direct]]
import { supabase } from "@/lib/supabase";

export const ACCOUNT_TYPES = ["매출", "매입원가", "인건비", "판관비", "세금과공과", "자본거래"] as const;
export type AccountType = (typeof ACCOUNT_TYPES)[number];

// 손익(매출-매입원가-인건비-판관비-세금과공과)에 들어가는 타입. 자본거래(대납/가지급금 등)는 제외.
export const PNL_TYPES: AccountType[] = ["매출", "매입원가", "인건비", "판관비", "세금과공과"];

// 재무상태표 5분류 — 복식부기 전표의 차변/대변 방향 판단용 (마이그 221).
export const GUBUN_TYPES = ["자산", "부채", "자본", "수익", "비용"] as const;
export type Gubun = (typeof GUBUN_TYPES)[number];

// type → gubun 기본 매핑. '자본거래'만 자산/부채 어느 쪽인지 애매해서 명시 필요(기본값 자산).
export function deriveGubun(type: AccountType, explicitGubun?: "자산" | "부채"): Gubun {
  if (type === "매출") return "수익";
  if (type === "자본거래") return explicitGubun ?? "자산";
  return "비용";
}

export interface AccountCategory {
  id: string;
  name: string;
  type: AccountType;
  gubun: Gubun;
  is_system?: boolean;
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
// includeSystem=true 로 부르면 보통예금/부가세대급금/부가세예수금 같은 내부 시스템계정도 섞어서 반환
// (수동전표 입력 시 필요 — 매트릭스/리스트의 일반 계정 선택엔 절대 안 섞음).
export async function loadAccountCategories(tenantId: string, opts?: { includeSystem?: boolean }): Promise<AccountCategory[]> {
  let q = supabase
    .from("account_categories")
    .select("id, name, type, gubun, is_system, sort_order, is_active")
    .eq("tenant_id", tenantId)
    .eq("is_active", true);
  if (!opts?.includeSystem) q = q.eq("is_system", false);
  const { data, error } = await q.order("sort_order").order("created_at");
  if (error) { console.error("loadAccountCategories:", error); return []; }
  return (data ?? []) as AccountCategory[];
}

export async function addAccountCategory(tenantId: string, name: string, type: AccountType, explicitGubun?: "자산" | "부채"): Promise<AccountCategory | null> {
  const { data: maxRow } = await supabase
    .from("account_categories").select("sort_order")
    .eq("tenant_id", tenantId).order("sort_order", { ascending: false }).limit(1).maybeSingle();
  const sort_order = (maxRow?.sort_order ?? 0) + 1;
  const { data, error } = await supabase
    .from("account_categories")
    .insert({ tenant_id: tenantId, name: name.trim(), type, gubun: deriveGubun(type, explicitGubun), sort_order })
    .select("id, name, type, gubun, is_system, sort_order, is_active")
    .single();
  if (error) { console.error("addAccountCategory:", error); return null; }
  return data as AccountCategory;
}

export async function renameAccountCategory(id: string, name: string): Promise<void> {
  await supabase.from("account_categories").update({ name: name.trim(), updated_at: new Date().toISOString() }).eq("id", id);
}

// 자본거래 타입 계정의 재무상태표 분류(자산/부채) 수정 — 마이그 221 백필값 교정용.
export async function updateAccountCategoryGubun(id: string, gubun: "자산" | "부채"): Promise<void> {
  await supabase.from("account_categories").update({ gubun, updated_at: new Date().toISOString() }).eq("id", id);
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
  name: string | null;
  retail_supplier_id: string | null;
  account_category_id: string | null;
  direction: "in" | "out";
  vat_included_default: boolean;
  bank_name: string | null;
  account_number: string | null;
  memo: string | null;
  management_tag: string | null;
  evidence_type: string | null;
  sort_order: number;
  category?: { name: string; type: AccountType } | null;
}

const LEDGER_PARTY_COLS = "id, name, retail_supplier_id, account_category_id, direction, vat_included_default, bank_name, account_number, memo, management_tag, evidence_type, sort_order";

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
  name: string | null;
  retail_supplier_id: string | null;
  account_category_id: string | null;
  direction: "in" | "out";
  vat_included_default: boolean;
  bank_name?: string | null;
  account_number?: string | null;
  memo?: string | null;
  management_tag?: string | null;
  evidence_type?: string | null;
}

export async function addLedgerParty(tenantId: string, input: AddLedgerPartyInput): Promise<LedgerParty | null> {
  const { data: maxRow } = await supabase
    .from("ledger_parties").select("sort_order")
    .eq("tenant_id", tenantId).order("sort_order", { ascending: false }).limit(1).maybeSingle();
  const sort_order = (maxRow?.sort_order ?? 0) + 1;
  const { data, error } = await supabase
    .from("ledger_parties")
    .insert({ tenant_id: tenantId, ...input, name: input.name?.trim() || null, sort_order })
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

// ── 복식부기 전표 (journal_entries/journal_lines, 마이그 221) ──────────
// cash_transactions 은 DB 트리거가 자동으로 2~3줄 균형전표를 만든다(현금은
// 항상 보통예금이 상대계정). 현금이 안 오가는 전표(감가상각/재고조정/이월
// 등)만 여기서 수동 생성 — source_cash_transaction_id 가 NULL 인 것들.
export interface JournalLineRow {
  id: string;
  entry_id: string;
  entry_date: string;
  memo: string | null;
  is_manual: boolean;          // source_cash_transaction_id NULL 여부
  account_name: string;
  gubun: Gubun;
  counterparty_name: string | null;
  debit_amount: number;
  credit_amount: number;
}

export async function loadJournalLines(tenantId: string, fromIso: string, toIso: string): Promise<JournalLineRow[]> {
  const { data, error } = await supabase
    .from("journal_lines")
    .select("id, entry_id, entry_date, counterparty_name, debit_amount, credit_amount, sort_order, account:account_categories(name, gubun), entry:journal_entries(memo, source_cash_transaction_id)")
    .eq("tenant_id", tenantId)
    .gte("entry_date", fromIso)
    .lte("entry_date", toIso)
    .order("entry_date")
    .order("entry_id")
    .order("sort_order");
  if (error) { console.error("loadJournalLines:", error); return []; }
  return (data ?? []).map(r => {
    const account = Array.isArray(r.account) ? r.account[0] : r.account;
    const entry = Array.isArray(r.entry) ? r.entry[0] : r.entry;
    return {
      id: r.id, entry_id: r.entry_id, entry_date: r.entry_date,
      memo: entry?.memo ?? null, is_manual: !entry?.source_cash_transaction_id,
      account_name: account?.name ?? "", gubun: (account?.gubun ?? "비용") as Gubun,
      counterparty_name: r.counterparty_name, debit_amount: r.debit_amount, credit_amount: r.credit_amount,
    };
  }) as JournalLineRow[];
}

export interface ManualJournalLineInput {
  account_category_id: string;
  counterparty_name: string | null;
  debit_amount: number;
  credit_amount: number;
}

// 수동 전표 생성 — 호출 전 차변합계=대변합계 검증은 UI 책임(여기선 그대로 박음).
export async function addManualJournalEntry(
  tenantId: string, entryDate: string, memo: string | null, lines: ManualJournalLineInput[]
): Promise<boolean> {
  const { data: entry, error: entryErr } = await supabase
    .from("journal_entries")
    .insert({ tenant_id: tenantId, entry_date: entryDate, memo: memo || null })
    .select("id")
    .single();
  if (entryErr || !entry) { console.error("addManualJournalEntry entry:", entryErr); return false; }

  const { error: linesErr } = await supabase.from("journal_lines").insert(
    lines.map((l, i) => ({
      entry_id: entry.id, tenant_id: tenantId, entry_date: entryDate,
      account_category_id: l.account_category_id, counterparty_name: l.counterparty_name,
      debit_amount: l.debit_amount, credit_amount: l.credit_amount, sort_order: i + 1,
    }))
  );
  if (linesErr) {
    console.error("addManualJournalEntry lines:", linesErr);
    await supabase.from("journal_entries").delete().eq("id", entry.id);
    return false;
  }
  return true;
}

// 수동 전표만 삭제 가능(현금거래 자동생성분은 cash_transactions 를 고쳐야 함) — UI 에서 is_manual 가드.
export async function deleteJournalEntry(entryId: string): Promise<void> {
  await supabase.from("journal_entries").delete().eq("id", entryId);
}

// ── 월마감 (accounting_periods, 마이그 223) ──────────────────────
// 입력 자체는 자유롭게(거래처/계정과목 나중에 채워도 됨) — 완성도 강제는
// 마감 시점으로 미룸. 부족한 행이 있으면 마감 자체를 막는다(검증은 UI 책임).
export interface PeriodStatus { closed: boolean; closedAt: string | null }

export async function loadPeriodStatus(tenantId: string, periodMonthIso: string): Promise<PeriodStatus> {
  const { data } = await supabase
    .from("accounting_periods")
    .select("closed_at")
    .eq("tenant_id", tenantId)
    .eq("period_month", periodMonthIso)
    .maybeSingle();
  return { closed: !!data?.closed_at, closedAt: data?.closed_at ?? null };
}

export async function closeMonth(tenantId: string, periodMonthIso: string): Promise<void> {
  await supabase.from("accounting_periods")
    .upsert({ tenant_id: tenantId, period_month: periodMonthIso, closed_at: new Date().toISOString() }, { onConflict: "tenant_id,period_month" });
}

export async function reopenMonth(tenantId: string, periodMonthIso: string): Promise<void> {
  await supabase.from("accounting_periods")
    .update({ closed_at: null })
    .eq("tenant_id", tenantId)
    .eq("period_month", periodMonthIso);
}

// ── 통장 기준잔액 (cash_balance_anchors, 마이그 224) ──────────────────
// 특정 날짜의 실제 통장 잔액 하나만 저장 — 이후 모든 날의 기초/기말잔액은
// 이 기준점 + cash_transactions 순증감 누적으로 매번 다시 계산(고정 저장 X).
export interface CashBalanceAnchor { as_of_date: string; amount: number }

export async function loadCashBalanceAnchor(tenantId: string): Promise<CashBalanceAnchor | null> {
  const { data } = await supabase
    .from("cash_balance_anchors")
    .select("as_of_date, amount")
    .eq("tenant_id", tenantId)
    .maybeSingle();
  return data as CashBalanceAnchor | null;
}

export async function setCashBalanceAnchor(tenantId: string, asOfDate: string, amount: number): Promise<void> {
  await supabase.from("cash_balance_anchors")
    .upsert({ tenant_id: tenantId, as_of_date: asOfDate, amount, updated_at: new Date().toISOString() }, { onConflict: "tenant_id" });
}

// 기준일(제외) 초과 ~ toIso(포함) 사이 순증감(입금-출금) 합계.
export async function loadNetCashDelta(tenantId: string, fromIsoExclusive: string, toIsoInclusive: string): Promise<number> {
  if (fromIsoExclusive >= toIsoInclusive) return 0;
  const { data, error } = await supabase
    .from("cash_transactions")
    .select("direction, amount")
    .eq("tenant_id", tenantId)
    .gt("txn_date", fromIsoExclusive)
    .lte("txn_date", toIsoInclusive);
  if (error) { console.error("loadNetCashDelta:", error); return 0; }
  return (data ?? []).reduce((s, r) => s + (r.direction === "in" ? r.amount : -r.amount), 0);
}
