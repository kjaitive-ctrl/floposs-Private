"use client";

// 영업 수수료 정산 (TEST2) — 영업네트워크 → retail tenant 매핑 → 월 정산.
//   수수료율 3단: referral.rate_override → agent.default_rate → 공통율(platform_settings).
//   결제액=부가세 포함. 공급가=결제액/1.1. 수수료=공급가×율(%).
//   결제액 출처: subscription_payments 우선 → 없으면 활성 플랜가 fallback(예상치).
//   마이그 190_sales_commission.sql 적용 필요.

import { useCallback, useEffect, useMemo, useState } from "react";
import * as XLSX from "xlsx";
import { supabase } from "@/lib/supabase";
import { krw } from "@/lib/format";
import { Modal } from "@floposs/ui";

type SalesAgent = {
  id: string;
  code: string | null;   // 영업 표식 (KIM, S001 ...)
  name: string;
  phone: string | null;
  memo: string | null;
  is_active: boolean;
  default_rate: number | null;
  issues_tax_invoice: boolean;   // 세금계산서
  is_business_income: boolean;   // 사업소득 (3.3%)
};

type PlanRef = { name: string; price: number } | null;

type Referral = {
  id: string;
  tenant_id: string;
  agent_id: string;
  rate_override: number | null;
  tenants: { company_name: string; plan_id: string | null; subscription_plans: PlanRef } | null;
  sales_agents: { name: string; code: string | null } | null;
};

type RetailTenant = {
  id: string;
  company_name: string;
  plan_id: string | null;
  subscription_plans: PlanRef;
};

type PaymentRow = { tenant_id: string; amount: number; period: string };

const round = (n: number) => Math.round(n);
const pct = (r: number) => `${r % 1 === 0 ? r : r.toFixed(2)}%`;

// 이번 달 'YYYY-MM' (Asia/Seoul)
function currentPeriod(): string {
  const f = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul", year: "numeric", month: "2-digit" });
  const parts = f.formatToParts(new Date());
  const y = parts.find(p => p.type === "year")?.value;
  const m = parts.find(p => p.type === "month")?.value;
  return `${y}-${m}`;
}

export default function SalesCommissionPage() {
  const [agents, setAgents] = useState<SalesAgent[]>([]);
  const [referrals, setReferrals] = useState<Referral[]>([]);
  const [retailTenants, setRetailTenants] = useState<RetailTenant[]>([]);
  const [payments, setPayments] = useState<PaymentRow[]>([]);
  const [globalRate, setGlobalRate] = useState(0);
  const [period, setPeriod] = useState(currentPeriod());
  const [loading, setLoading] = useState(true);
  const [needsMigration, setNeedsMigration] = useState(false);

  // 공통율 편집
  const [rateDraft, setRateDraft] = useState("");
  const [rateSaving, setRateSaving] = useState(false);

  // 영업 모달
  const [agentModal, setAgentModal] = useState(false);
  const [editingAgent, setEditingAgent] = useState<SalesAgent | null>(null);

  // 매핑 모달
  const [refModal, setRefModal] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    const [agentsRes, refsRes, tenantsRes, settingsRes] = await Promise.all([
      supabase.from("sales_agents").select("*").order("created_at"),
      supabase.from("tenant_referrals")
        .select("id, tenant_id, agent_id, rate_override, tenants(company_name, plan_id, subscription_plans(name, price)), sales_agents(name, code)")
        .is("ended_at", null),
      supabase.from("tenants")
        .select("id, company_name, plan_id, subscription_plans(name, price)")
        .eq("tenant_type", "retail")
        .order("company_name"),
      supabase.from("platform_settings").select("default_commission_rate").eq("id", 1).maybeSingle(),
    ]);

    // sales_agents 조회 실패 = 마이그 미적용 신호
    setNeedsMigration(!!agentsRes.error);

    setAgents((agentsRes.data as SalesAgent[]) ?? []);
    setReferrals((refsRes.data as unknown as Referral[]) ?? []);
    setRetailTenants((tenantsRes.data as unknown as RetailTenant[]) ?? []);
    const gr = (settingsRes.data as { default_commission_rate?: number } | null)?.default_commission_rate ?? 0;
    setGlobalRate(Number(gr));
    setRateDraft(String(Number(gr)));
    setLoading(false);
  }, []);

  // period 바뀌면 결제 원장 다시 조회
  const loadPayments = useCallback(async () => {
    const { data } = await supabase
      .from("subscription_payments")
      .select("tenant_id, amount, period")
      .eq("period", period);
    setPayments((data as PaymentRow[]) ?? []);
  }, [period]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { loadPayments(); }, [loadPayments]);

  // ── 수수료율 해석 ──
  const agentById = useMemo(() => new Map(agents.map(a => [a.id, a])), [agents]);
  function effectiveRate(ref: Referral): number {
    if (ref.rate_override != null) return Number(ref.rate_override);
    const a = agentById.get(ref.agent_id);
    if (a?.default_rate != null) return Number(a.default_rate);
    return globalRate;
  }

  // ── 정산 계산 (period 기준) ──
  type Line = {
    agentId: string; agentName: string; agentCode: string; tenantId: string; companyName: string;
    planName: string; paidAmount: number; baseAmount: number; rate: number;
    commission: number; isEstimated: boolean;
  };
  const lines: Line[] = useMemo(() => {
    return referrals.map(ref => {
      const t = ref.tenants;
      const payment = payments.find(p => p.tenant_id === ref.tenant_id);
      const planPrice = t?.subscription_plans?.price ?? 0;
      const paidAmount = payment ? Number(payment.amount) : Number(planPrice);
      const isEstimated = !payment;
      const baseAmount = round(paidAmount / 1.1); // 부가세 제외 공급가
      const rate = effectiveRate(ref);
      const commission = round((baseAmount * rate) / 100);
      return {
        agentId: ref.agent_id,
        agentName: ref.sales_agents?.name ?? "(삭제된 영업)",
        agentCode: ref.sales_agents?.code ?? "",
        tenantId: ref.tenant_id,
        companyName: t?.company_name ?? "(삭제된 업체)",
        planName: t?.subscription_plans?.name ?? "-",
        paidAmount, baseAmount, rate, commission, isEstimated,
      };
    }).filter(l => l.paidAmount > 0);
  }, [referrals, payments, agents, globalRate]); // eslint-disable-line react-hooks/exhaustive-deps

  // 영업별 그룹
  const byAgent = useMemo(() => {
    const m = new Map<string, { agentId: string; agentName: string; agentCode: string; lines: Line[]; base: number; commission: number }>();
    for (const l of lines) {
      const g = m.get(l.agentId) ?? { agentId: l.agentId, agentName: l.agentName, agentCode: l.agentCode, lines: [], base: 0, commission: 0 };
      g.lines.push(l);
      g.base += l.baseAmount;
      g.commission += l.commission;
      m.set(l.agentId, g);
    }
    return [...m.values()];
  }, [lines]);

  const totalCommission = lines.reduce((s, l) => s + l.commission, 0);
  const hasEstimated = lines.some(l => l.isEstimated);

  // ── 공통율 저장 ──
  async function saveGlobalRate() {
    const val = Number(rateDraft);
    if (isNaN(val) || val < 0) return alert("올바른 수수료율(%)을 입력해주세요.");
    setRateSaving(true);
    const { error } = await supabase.from("platform_settings").update({ default_commission_rate: val }).eq("id", 1);
    setRateSaving(false);
    if (error) return alert("저장 실패: " + error.message);
    setGlobalRate(val);
  }

  // ── 영업 삭제 ──
  async function deleteAgent(a: SalesAgent) {
    const mapped = referrals.filter(r => r.agent_id === a.id).length;
    const warn = mapped > 0 ? `\n\n⚠ 이 영업에 매핑된 고객이 ${mapped}곳 있습니다. 매핑도 함께 삭제됩니다.` : "";
    if (!confirm(`"${a.name}" 영업을 삭제하시겠습니까?${warn}`)) return;
    const { error } = await supabase.from("sales_agents").delete().eq("id", a.id);
    if (error) return alert(error.message);
    load();
  }

  // ── 매핑 해제 ──
  async function removeReferral(ref: Referral) {
    if (!confirm(`"${ref.tenants?.company_name}" — "${ref.sales_agents?.name}" 매핑을 해제하시겠습니까?`)) return;
    const { error } = await supabase
      .from("tenant_referrals")
      .update({ ended_at: new Date().toISOString().slice(0, 10) })
      .eq("id", ref.id);
    if (error) return alert(error.message);
    load();
  }

  // ── 정산 확정 (박제) ──
  async function confirmSettlement() {
    if (byAgent.length === 0) return;
    if (!confirm(`${period} 정산을 확정(박제)하시겠습니까?\n현재 수수료율·금액이 그대로 저장되며, 이후 율을 바꿔도 이 달 정산은 불변입니다.`)) return;

    for (const g of byAgent) {
      const agentId = g.agentId;
      // 헤더 upsert
      const { data: header, error: hErr } = await supabase
        .from("commission_settlements")
        .upsert({
          agent_id: agentId, period,
          total_base: g.base, total_commission: g.commission,
          status: "confirmed", confirmed_at: new Date().toISOString(),
        }, { onConflict: "agent_id,period" })
        .select("id")
        .single();
      if (hErr || !header) { alert("확정 실패: " + (hErr?.message ?? "")); return; }
      // 기존 라인 삭제 후 재박제
      await supabase.from("commission_settlement_items").delete().eq("settlement_id", header.id);
      const items = g.lines.map(l => ({
        settlement_id: header.id, tenant_id: l.tenantId, company_name: l.companyName,
        plan_name: l.planName, paid_amount: l.paidAmount, base_amount: l.baseAmount,
        rate: l.rate, commission: l.commission, is_estimated: l.isEstimated,
      }));
      const { error: iErr } = await supabase.from("commission_settlement_items").insert(items);
      if (iErr) { alert("라인 박제 실패: " + iErr.message); return; }
    }
    alert(`${period} 정산 확정 완료 (영업 ${byAgent.length}명).`);
  }

  // ── Excel 다운로드 ──
  function downloadExcel() {
    if (lines.length === 0) return alert("정산 대상이 없습니다.");
    const taxLabel = (agentId: string) => {
      const a = agentById.get(agentId);
      return [a?.issues_tax_invoice ? "세금계산서" : "", a?.is_business_income ? "사업소득" : ""].filter(Boolean).join("·");
    };
    const header = ["영업코드", "영업", "세무구분", "고객(업체명)", "플랜", "결제액(VAT포함)", "공급가(VAT제외)", "수수료율", "수수료", "비고"];
    const rows = lines.map(l => [
      l.agentCode, l.agentName, taxLabel(l.agentId), l.companyName, l.planName, l.paidAmount, l.baseAmount, pct(l.rate), l.commission,
      l.isEstimated ? "예상(플랜가)" : "실결제",
    ]);
    const totalRow = ["합계", "", "", "", "", "", lines.reduce((s, l) => s + l.baseAmount, 0), "", totalCommission, ""];
    const ws = XLSX.utils.aoa_to_sheet([header, ...rows, [], totalRow]);
    ws["!cols"] = [{ wch: 10 }, { wch: 10 }, { wch: 14 }, { wch: 22 }, { wch: 12 }, { wch: 14 }, { wch: 14 }, { wch: 9 }, { wch: 12 }, { wch: 12 }];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, period);
    XLSX.writeFile(wb, `영업수수료정산_${period}.xlsx`);
  }

  const availableTenants = retailTenants.filter(t => !referrals.some(r => r.tenant_id === t.id));

  return (
    <div className="max-w-5xl space-y-6">
      <div>
        <h2 className="text-2xl font-bold text-gray-900">영업 수수료 정산</h2>
        <p className="text-sm text-gray-500 mt-1">
          영업네트워크가 데려온 소매 고객의 구독 결제액 × 수수료율을 월별로 정산합니다. (결제액 부가세 포함 → 공급가 기준)
        </p>
      </div>

      {needsMigration && (
        <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 text-xs text-amber-800">
          ⚠ <strong>마이그 190_sales_commission.sql</strong> 이 아직 적용되지 않았습니다. Supabase 에 적용하면 아래 기능이 동작합니다. (지금은 레이아웃 미리보기)
        </div>
      )}

      {/* 1. 공통 수수료율 + 영업네트워크 */}
      <section className="bg-white rounded-xl border border-gray-200 p-5 space-y-4">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold text-gray-700">영업네트워크</h3>
          <button onClick={() => { setEditingAgent(null); setAgentModal(true); }}
            className="px-3 py-1.5 bg-primary text-white text-xs rounded-lg hover:bg-primary-hover">
            + 영업 추가
          </button>
        </div>

        {/* 공통율 */}
        <div className="flex items-center gap-2 p-3 bg-gray-50 rounded-lg">
          <span className="text-xs text-gray-600">공통 기본 수수료율</span>
          <input type="number" step="0.5" value={rateDraft} onChange={e => setRateDraft(e.target.value)}
            className="w-20 input-md text-sm" />
          <span className="text-xs text-gray-500">%</span>
          <button onClick={saveGlobalRate} disabled={rateSaving}
            className="px-3 py-1.5 border border-gray-300 text-gray-600 text-xs rounded-lg hover:bg-gray-50 disabled:opacity-50">
            {rateSaving ? "저장 중..." : "저장"}
          </button>
          <span className="text-[11px] text-gray-400 ml-1">영업/매핑 개별율이 없을 때 적용</span>
        </div>

        {loading ? (
          <p className="text-gray-400 text-sm">불러오는 중...</p>
        ) : agents.length === 0 ? (
          <div className="text-center py-8 text-gray-300 text-sm">등록된 영업이 없습니다.</div>
        ) : (
          <table className="w-full text-sm">
            <thead className="border-b border-gray-200 text-xs text-gray-500">
              <tr className="text-left">
                <th className="py-2">코드</th>
                <th className="py-2">이름</th>
                <th className="py-2">연락처</th>
                <th className="py-2 text-center">개별율</th>
                <th className="py-2 text-center">담당 고객</th>
                <th className="py-2">메모</th>
                <th className="py-2 text-right">관리</th>
              </tr>
            </thead>
            <tbody>
              {agents.map(a => {
                const count = referrals.filter(r => r.agent_id === a.id).length;
                return (
                  <tr key={a.id} className="border-b border-gray-100 last:border-0">
                    <td className="py-2">
                      {a.code ? <span className="text-xs font-mono px-1.5 py-0.5 bg-gray-100 text-gray-600 rounded">{a.code}</span> : <span className="text-gray-300 text-xs">-</span>}
                    </td>
                    <td className="py-2 font-medium text-gray-900">
                      {a.name}{!a.is_active && <span className="ml-1 text-[10px] text-gray-400">(비활성)</span>}
                      {a.issues_tax_invoice && <span className="ml-1 text-[10px] px-1 py-0.5 bg-blue-50 text-blue-600 rounded">세금계산서</span>}
                      {a.is_business_income && <span className="ml-1 text-[10px] px-1 py-0.5 bg-purple-50 text-purple-600 rounded">사업소득</span>}
                    </td>
                    <td className="py-2 text-gray-600 text-xs">{a.phone || "-"}</td>
                    <td className="py-2 text-center text-gray-700">{a.default_rate != null ? pct(Number(a.default_rate)) : <span className="text-gray-300">공통</span>}</td>
                    <td className="py-2 text-center text-gray-600">{count}곳</td>
                    <td className="py-2 text-gray-500 text-xs">{a.memo || "-"}</td>
                    <td className="py-2 text-right">
                      <button onClick={() => { setEditingAgent(a); setAgentModal(true); }}
                        className="text-xs px-2.5 py-1 border border-gray-300 rounded-lg text-gray-600 hover:bg-gray-50 mr-1">수정</button>
                      <button onClick={() => deleteAgent(a)}
                        className="text-xs px-2.5 py-1 border border-red-200 text-red-500 rounded-lg hover:bg-red-50">삭제</button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </section>

      {/* 2. 고객 매핑 */}
      <section className="bg-white rounded-xl border border-gray-200 p-5 space-y-4">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold text-gray-700">고객 매핑 <span className="text-xs text-gray-400 ml-1">(누가 데려온 소매 tenant)</span></h3>
          <button onClick={() => setRefModal(true)}
            className="px-3 py-1.5 bg-primary text-white text-xs rounded-lg hover:bg-primary-hover">
            + 매핑 추가
          </button>
        </div>

        {agents.length === 0 ? (
          <div className="text-center py-8 text-sm text-amber-600 bg-amber-50 rounded-lg">
            먼저 위 <strong>영업네트워크</strong>에서 영업을 1명 이상 등록해주세요. (매핑 = 영업 ↔ 소매 고객 연결)
          </div>
        ) : referrals.length === 0 ? (
          <div className="text-center py-8 text-gray-300 text-sm">매핑된 고객이 없습니다.</div>
        ) : (
          <table className="w-full text-sm">
            <thead className="border-b border-gray-200 text-xs text-gray-500">
              <tr className="text-left">
                <th className="py-2">소매 고객</th>
                <th className="py-2">담당 영업</th>
                <th className="py-2">플랜</th>
                <th className="py-2 text-center">적용 수수료율</th>
                <th className="py-2 text-right">관리</th>
              </tr>
            </thead>
            <tbody>
              {referrals.map(r => (
                <tr key={r.id} className="border-b border-gray-100 last:border-0">
                  <td className="py-2 font-medium text-gray-900">{r.tenants?.company_name ?? "-"}</td>
                  <td className="py-2 text-gray-700">
                    {r.sales_agents?.code && <span className="text-xs font-mono text-gray-400 mr-1">[{r.sales_agents.code}]</span>}
                    {r.sales_agents?.name ?? "-"}
                  </td>
                  <td className="py-2 text-gray-600 text-xs">
                    {r.tenants?.subscription_plans?.name ?? "플랜없음"}
                    {r.tenants?.subscription_plans?.price ? <span className="text-gray-400 ml-1">{krw(r.tenants.subscription_plans.price)}</span> : null}
                  </td>
                  <td className="py-2 text-center text-gray-700">
                    {pct(effectiveRate(r))}
                    {r.rate_override != null && <span className="ml-1 text-[10px] text-primary">개별</span>}
                  </td>
                  <td className="py-2 text-right">
                    <button onClick={() => removeReferral(r)}
                      className="text-xs px-2.5 py-1 border border-red-200 text-red-500 rounded-lg hover:bg-red-50">해제</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {/* 3. 월별 정산 */}
      <section className="bg-white rounded-xl border border-gray-200 p-5 space-y-4">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <h3 className="text-sm font-semibold text-gray-700">월별 정산</h3>
          <div className="flex items-center gap-2">
            <input type="month" value={period} onChange={e => setPeriod(e.target.value)}
              className="input-md text-sm" />
            <button onClick={downloadExcel} disabled={lines.length === 0}
              className="px-3 py-1.5 border border-gray-300 text-gray-700 text-xs rounded-lg hover:bg-gray-50 disabled:opacity-40">
              Excel 다운로드
            </button>
            <button onClick={confirmSettlement} disabled={byAgent.length === 0}
              className="px-3 py-1.5 bg-primary text-white text-xs rounded-lg hover:bg-primary-hover disabled:opacity-40">
              이 달 정산 확정
            </button>
          </div>
        </div>

        {hasEstimated && (
          <p className="text-[11px] text-amber-600">
            ⚠ 실제 결제 원장이 없는 고객은 <strong>활성 플랜가 기준 예상치</strong>로 계산됩니다. (유료화 후 실결제 입력 시 자동 반영)
          </p>
        )}

        {byAgent.length === 0 ? (
          <div className="text-center py-8 text-gray-300 text-sm">{period} 정산 대상이 없습니다.</div>
        ) : (
          <div className="space-y-4">
            {byAgent.map(g => (
              <div key={g.agentId} className="border border-gray-100 rounded-lg overflow-hidden">
                <div className="flex items-center justify-between px-4 py-2 bg-gray-50">
                  <span className="text-sm font-semibold text-gray-800">
                    {g.agentCode && <span className="text-xs font-mono text-gray-400 mr-1.5">[{g.agentCode}]</span>}
                    {g.agentName}
                  </span>
                  <span className="text-sm text-gray-700">수수료 합계 <strong className="text-primary">{krw(g.commission)}</strong></span>
                </div>
                <table className="w-full text-sm">
                  <thead className="text-xs text-gray-400 border-b border-gray-100">
                    <tr className="text-left">
                      <th className="px-4 py-1.5">고객</th>
                      <th className="px-4 py-1.5 text-right">결제액</th>
                      <th className="px-4 py-1.5 text-right">공급가</th>
                      <th className="px-4 py-1.5 text-center">율</th>
                      <th className="px-4 py-1.5 text-right">수수료</th>
                    </tr>
                  </thead>
                  <tbody>
                    {g.lines.map(l => (
                      <tr key={l.tenantId} className="border-b border-gray-50 last:border-0">
                        <td className="px-4 py-1.5 text-gray-800">
                          {l.companyName}
                          {l.isEstimated && <span className="ml-1 text-[10px] text-amber-500">예상</span>}
                        </td>
                        <td className="px-4 py-1.5 text-right text-gray-600">{krw(l.paidAmount)}</td>
                        <td className="px-4 py-1.5 text-right text-gray-600">{krw(l.baseAmount)}</td>
                        <td className="px-4 py-1.5 text-center text-gray-500">{pct(l.rate)}</td>
                        <td className="px-4 py-1.5 text-right font-medium text-gray-900">{krw(l.commission)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ))}
            <div className="flex justify-end pt-2 border-t border-gray-200">
              <span className="text-sm text-gray-700">전체 수수료 합계 <strong className="text-lg text-primary ml-1">{krw(totalCommission)}</strong></span>
            </div>
          </div>
        )}
      </section>

      {agentModal && (
        <AgentModal agent={editingAgent} onClose={() => setAgentModal(false)} onSaved={() => { setAgentModal(false); load(); }} />
      )}
      {refModal && (
        <ReferralModal agents={agents} tenants={availableTenants} onClose={() => setRefModal(false)} onSaved={() => { setRefModal(false); load(); }} />
      )}
    </div>
  );
}

// ── 영업 추가/수정 모달 ──
function AgentModal({ agent, onClose, onSaved }: { agent: SalesAgent | null; onClose: () => void; onSaved: () => void }) {
  const [code, setCode] = useState(agent?.code ?? "");
  const [name, setName] = useState(agent?.name ?? "");
  const [phone, setPhone] = useState(agent?.phone ?? "");
  const [memo, setMemo] = useState(agent?.memo ?? "");
  const [rate, setRate] = useState(agent?.default_rate != null ? String(agent.default_rate) : "");
  const [isActive, setIsActive] = useState(agent?.is_active ?? true);
  // 세무구분 상호배타 — 세금계산서 / 사업소득 택1 (신규 기본 = 세금계산서). DB 는 두 boolean 으로 박제.
  const [taxType, setTaxType] = useState<"tax" | "biz">(
    agent?.is_business_income ? "biz" : "tax"
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  // 비우면 SA-NNNN 자동부여 (기존 코드 최대 번호+1). 충돌 시 UNIQUE 제약이 23505.
  async function nextAutoCode(): Promise<string> {
    const { data } = await supabase.from("sales_agents").select("code").like("code", "SA-%");
    const max = (data ?? []).reduce((m, r: { code: string | null }) => {
      const n = Number((r.code ?? "").replace("SA-", ""));
      return isNaN(n) ? m : Math.max(m, n);
    }, 0);
    return `SA-${String(max + 1).padStart(4, "0")}`;
  }

  async function save() {
    if (!name.trim()) return setError("이름을 입력해주세요.");
    setSaving(true); setError("");
    const finalCode = code.trim() || (agent ? null : await nextAutoCode());
    const payload = {
      code: finalCode, name: name.trim(), phone: phone.trim() || null, memo: memo.trim() || null,
      default_rate: rate.trim() === "" ? null : Number(rate), is_active: isActive,
      issues_tax_invoice: taxType === "tax", is_business_income: taxType === "biz",
    };
    const { error } = agent
      ? await supabase.from("sales_agents").update(payload).eq("id", agent.id)
      : await supabase.from("sales_agents").insert(payload);
    setSaving(false);
    if (error) return setError(error.code === "23505" ? "이미 존재하는 영업 코드입니다." : error.message);
    onSaved();
  }

  return (
    <Modal onClose={() => !saving && onClose()} size="md">
      <div className="p-5 border-b border-gray-100">
        <h3 className="text-lg font-bold text-gray-900">{agent ? "영업 수정" : "영업 추가"}</h3>
      </div>
      <div className="p-5 space-y-3">
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-xs text-gray-600 mb-1">영업 코드 (표식)</label>
            <input value={code} onChange={e => setCode(e.target.value)} placeholder="비우면 SA-0001 자동" className="w-full input-md font-mono" />
          </div>
          <div>
            <label className="block text-xs text-gray-600 mb-1">이름 *</label>
            <input value={name} onChange={e => setName(e.target.value)} placeholder="김영업" className="w-full input-md" />
          </div>
        </div>
        <div>
          <label className="block text-xs text-gray-600 mb-1">연락처</label>
          <input value={phone} onChange={e => setPhone(e.target.value)} className="w-full input-md" />
        </div>
        <div>
          <label className="block text-xs text-gray-600 mb-1">개별 수수료율 (%)</label>
          <input type="number" step="0.5" value={rate} onChange={e => setRate(e.target.value)}
            placeholder="비우면 공통율 적용" className="w-full input-md" />
        </div>
        <div>
          <label className="block text-xs text-gray-600 mb-1">메모</label>
          <input value={memo} onChange={e => setMemo(e.target.value)} className="w-full input-md" />
        </div>
        <div>
          <label className="block text-xs text-gray-600 mb-1.5">수수료 지급 세무 구분 <span className="text-gray-400">(택1)</span></label>
          <div className="flex gap-4">
            {([
              { key: "tax", label: "세금계산서" },
              { key: "biz", label: "사업소득 (3.3%)" },
            ] as const).map(o => (
              <label key={o.key} className="flex items-center gap-2 text-sm text-gray-700">
                <input type="radio" name="taxType" checked={taxType === o.key}
                  onChange={() => setTaxType(o.key)} className="rounded" />
                {o.label}
              </label>
            ))}
          </div>
        </div>
        <label className="flex items-center gap-2 text-sm text-gray-700">
          <input type="checkbox" checked={isActive} onChange={e => setIsActive(e.target.checked)} className="rounded" />
          활성
        </label>
        {error && <p className="text-sm text-red-500">{error}</p>}
      </div>
      <div className="flex gap-2 p-5 border-t border-gray-100">
        <button onClick={onClose} disabled={saving} className="flex-1 py-2.5 border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50 text-sm">취소</button>
        <button onClick={save} disabled={saving} className="flex-1 py-2.5 bg-primary text-white rounded-lg hover:bg-primary-hover disabled:opacity-50 font-medium text-sm">
          {saving ? "저장 중..." : agent ? "수정 완료" : "추가"}
        </button>
      </div>
    </Modal>
  );
}

// ── 매핑 추가 모달 ──
function ReferralModal({ agents, tenants, onClose, onSaved }: {
  agents: SalesAgent[]; tenants: RetailTenant[]; onClose: () => void; onSaved: () => void;
}) {
  const [tenantId, setTenantId] = useState("");
  const [agentId, setAgentId] = useState("");
  const [rateOverride, setRateOverride] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  async function save() {
    if (!tenantId) return setError("소매 고객을 선택해주세요.");
    if (!agentId) return setError("담당 영업을 선택해주세요.");
    setSaving(true); setError("");
    const { error } = await supabase.from("tenant_referrals").insert({
      tenant_id: tenantId, agent_id: agentId,
      rate_override: rateOverride.trim() === "" ? null : Number(rateOverride),
    });
    setSaving(false);
    if (error) return setError(error.code === "23505" ? "이미 진행 중인 매핑이 있는 고객입니다." : error.message);
    onSaved();
  }

  return (
    <Modal onClose={() => !saving && onClose()} size="md">
      <div className="p-5 border-b border-gray-100">
        <h3 className="text-lg font-bold text-gray-900">고객 매핑 추가</h3>
      </div>
      <div className="p-5 space-y-3">
        <div>
          <label className="block text-xs text-gray-600 mb-1">소매 고객 *</label>
          <select value={tenantId} onChange={e => setTenantId(e.target.value)} className="w-full input-md">
            <option value="">선택</option>
            {tenants.map(t => (
              <option key={t.id} value={t.id}>
                {t.company_name}{t.subscription_plans?.name ? ` (${t.subscription_plans.name})` : ""}
              </option>
            ))}
          </select>
          {tenants.length === 0 && <p className="text-[11px] text-gray-400 mt-1">매핑 가능한 소매 고객이 없습니다.</p>}
        </div>
        <div>
          <label className="block text-xs text-gray-600 mb-1">담당 영업 *</label>
          <select value={agentId} onChange={e => setAgentId(e.target.value)} className="w-full input-md">
            <option value="">선택</option>
            {agents.filter(a => a.is_active).map(a => (
              <option key={a.id} value={a.id}>{a.code ? `[${a.code}] ${a.name}` : a.name}</option>
            ))}
          </select>
          {agents.filter(a => a.is_active).length === 0 && (
            <p className="text-[11px] text-amber-600 mt-1">활성 영업이 없습니다. 먼저 영업네트워크에서 영업을 추가해주세요.</p>
          )}
        </div>
        <div>
          <label className="block text-xs text-gray-600 mb-1">개별 수수료율 (%)</label>
          <input type="number" step="0.5" value={rateOverride} onChange={e => setRateOverride(e.target.value)}
            placeholder="비우면 영업/공통율 적용" className="w-full input-md" />
        </div>
        {error && <p className="text-sm text-red-500">{error}</p>}
      </div>
      <div className="flex gap-2 p-5 border-t border-gray-100">
        <button onClick={onClose} disabled={saving} className="flex-1 py-2.5 border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50 text-sm">취소</button>
        <button onClick={save} disabled={saving} className="flex-1 py-2.5 bg-primary text-white rounded-lg hover:bg-primary-hover disabled:opacity-50 font-medium text-sm">
          {saving ? "저장 중..." : "추가"}
        </button>
      </div>
    </Modal>
  );
}
