import { supabase } from "./supabase";
import { getBizSessionId } from "./bizSession";

export type TransactionInsert = {
  tenant_id: string;
  customer_id: string | null;
  type: "income" | "expense" | "receivable";
  method: string;
  amount: number;
  source: string;
  transaction_date: string;
  outstanding_snapshot?: number | null;
  order_id?: string | null;
  order_item_id?: string | null;
  supply_amount?: number;
  vat_amount?: number;
  description?: string | null;
};

export async function insertTransaction(data: TransactionInsert) {
  const bizSessionId = getBizSessionId();
  if (!bizSessionId) {
    return { data: null, error: { message: "영업개시가 필요합니다.", code: "BIZ_NOT_OPEN" } };
  }
  return supabase.from("transactions").insert({
    ...data,
    biz_session_id: bizSessionId,
  });
}

export async function insertTransactions(rows: TransactionInsert[]) {
  const bizSessionId = getBizSessionId();
  if (!bizSessionId) {
    return { data: null, error: { message: "영업개시가 필요합니다.", code: "BIZ_NOT_OPEN" } };
  }
  return supabase.from("transactions").insert(
    rows.map(r => ({ ...r, biz_session_id: bizSessionId }))
  );
}
