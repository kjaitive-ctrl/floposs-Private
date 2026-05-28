import { NextRequest, NextResponse } from "next/server";
import { isAIEnabled, hasApiKey, complete, type AIModelAlias } from "@/lib/anthropic";
import { getSupabaseRouteClient } from "@/lib/supabase-server";
import { supabaseAdmin } from "@/lib/supabase-admin";

// 범용 Claude 1-턴 호출 라우트 (밑작업, 메뉴 X).
//   POST /api/ai/complete
//   body: { prompt, system?, model?: "opus"|"sonnet"|"haiku", maxTokens? }
//   응답: { text, credits_charged, balance_after }
//
// 흐름:
//   1) AI_ENABLED + 키 확인 (휴면 가드)
//   2) Supabase 세션 → tenant_id 확인 (인증)
//   3) 잔액 가드 — 0 이면 Anthropic 호출 없이 402
//   4) Claude 호출 → usage 토큰 받음
//   5) charge_ai_usage RPC — usage 박제 + 잔액 차감 atomic (마이그 191)
//
// 박제 정합: usage 와 charge 가 한 트랜잭션. 호출 후 차감 실패 시 RPC 가 EXCEPTION → 호출자 catch.
export async function POST(req: NextRequest) {
  // 1) 휴면 가드
  if (!isAIEnabled()) {
    return NextResponse.json({ error: "AI 비활성 (AI_ENABLED=true 설정 시 동작)" }, { status: 503 });
  }
  if (!hasApiKey()) {
    return NextResponse.json({ error: "ANTHROPIC_API_KEY 미설정" }, { status: 503 });
  }

  // 2) 인증 → tenant_id 확인
  const supabase = await getSupabaseRouteClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }
  const tenantId = (user.app_metadata as { tenant_id?: string } | undefined)?.tenant_id;
  if (!tenantId) {
    return NextResponse.json({ error: "tenant_id not set" }, { status: 500 });
  }

  // 3) body 파싱
  let body: { prompt?: unknown; system?: unknown; model?: unknown; maxTokens?: unknown };
  try { body = await req.json(); } catch {
    return NextResponse.json({ error: "잘못된 JSON 요청" }, { status: 400 });
  }
  const prompt = typeof body.prompt === "string" ? body.prompt : "";
  if (!prompt.trim()) {
    return NextResponse.json({ error: "prompt 가 비어있습니다" }, { status: 400 });
  }
  const system = typeof body.system === "string" ? body.system : undefined;
  const modelAlias = (typeof body.model === "string" && ["opus", "sonnet", "haiku"].includes(body.model))
    ? (body.model as AIModelAlias)
    : undefined;
  const maxTokens = typeof body.maxTokens === "number" && body.maxTokens > 0 && body.maxTokens <= 4096
    ? body.maxTokens
    : undefined;

  // 4) 잔액 사전 가드 — 0 이면 Anthropic 비용 발생 전에 차단
  const { data: creditRow } = await supabaseAdmin
    .from("tenant_credits")
    .select("balance")
    .eq("tenant_id", tenantId)
    .maybeSingle();
  const currentBalance = creditRow?.balance ?? 0;
  if (currentBalance <= 0) {
    return NextResponse.json(
      { error: "크레딧 잔액이 없습니다. 충전이 필요합니다.", balance: currentBalance },
      { status: 402 },
    );
  }

  // 5) Claude 호출
  let result;
  try {
    result = await complete({ prompt, system, model: modelAlias, maxTokens });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: message }, { status: 502 });
  }

  // 6) 정산 RPC — usage 박제 + 잔액 차감 atomic
  const { data: chargeResult, error: chargeError } = await supabaseAdmin.rpc("charge_ai_usage", {
    p_tenant_id: tenantId,
    p_route: "/api/ai/complete",
    p_model: result.model,
    p_input_tokens: result.usage.input_tokens,
    p_output_tokens: result.usage.output_tokens,
    p_user_email: user.email ?? null,
  });

  if (chargeError) {
    // 정산 실패 — Anthropic 호출은 이미 완료된 상태. 텍스트는 반환하되 에러도 노출.
    // (마이그 191 미적용 또는 잔액 부족(P0001) 케이스. 후자는 사전 가드로 이미 걸렀어야)
    return NextResponse.json({
      text: result.text,
      charge_error: chargeError.message,
      warning: "AI 호출 성공 but 정산 실패 — 마이그 191 적용 확인 필요",
    }, { status: 200 });
  }

  const charge = chargeResult as { credits_charged: number; balance_after: number; cost_usd: number; usage_id: string };
  return NextResponse.json({
    text: result.text,
    credits_charged: charge.credits_charged,
    balance_after: charge.balance_after,
    cost_usd: charge.cost_usd,
  });
}
