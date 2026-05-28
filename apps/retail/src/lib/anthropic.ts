import "server-only";
import Anthropic from "@anthropic-ai/sdk";

// Claude(Anthropic Console) 연동 — 서버 전용 배관.
//
// ⚠️ API 키는 절대 브라우저로 내려보내지 않는다. retail 의 "브라우저 직통 Supabase"
//    원칙([[feedback_retail_browser_supabase_direct]])은 AI 호출엔 적용 안 됨 —
//    AI 는 반드시 이 헬퍼를 거치는 /api/ai/* 서버 라우트로만 호출.
//    `import "server-only"` 로 클라이언트 번들 유입을 컴파일 단계에서 차단.
//
// 현재 = 밑작업(연동만). 어떤 메뉴/UI 에도 안 걸려 있음(휴면).
//   - AI_ENABLED=true 일 때만 라우트가 동작 (기본 off → 503).
//   - 나중에 기능 붙일 때 이 헬퍼의 complete() 에 연결만 하면 됨.

// 모델 상수 — 호출부는 별칭만 쓰고 실제 ID 는 여기서 한 곳 관리.
export const AI_MODELS = {
  opus: "claude-opus-4-7",
  sonnet: "claude-sonnet-4-6",
  haiku: "claude-haiku-4-5-20251001",
} as const;

export type AIModelAlias = keyof typeof AI_MODELS;

// 기본 모델 — 품질/비용 균형. 단순/대량 작업은 호출부에서 "haiku" 로 다운시프트.
export const DEFAULT_MODEL: AIModelAlias = "sonnet";

export function isAIEnabled(): boolean {
  return process.env.AI_ENABLED === "true";
}

export function hasApiKey(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

// 지연 초기화 싱글톤 — 키 없으면 명시적 에러.
let client: Anthropic | null = null;
export function getAnthropic(): Anthropic {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error("ANTHROPIC_API_KEY 가 설정되지 않았습니다 (서버 환경변수).");
  }
  if (!client) {
    client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }
  return client;
}

export interface CompleteParams {
  prompt: string;
  system?: string;
  model?: AIModelAlias;
  maxTokens?: number;
}

export interface CompleteResult {
  text: string;
  // 크레딧 차감 계산용 — Anthropic 실측 토큰 (charge_ai_usage RPC 에 그대로 전달).
  usage: { input_tokens: number; output_tokens: number };
  // 우리가 호출한 모델 ID (platform_settings.ai_model_pricing 키와 일치).
  model: string;
}

// 범용 1-턴 호출. usage 포함 반환 → 크레딧 정산에 사용 (마이그 191).
export async function complete({
  prompt,
  system,
  model = DEFAULT_MODEL,
  maxTokens = 1024,
}: CompleteParams): Promise<CompleteResult> {
  const anthropic = getAnthropic();
  const modelId = AI_MODELS[model];
  const res = await anthropic.messages.create({
    model: modelId,
    max_tokens: maxTokens,
    ...(system ? { system } : {}),
    messages: [{ role: "user", content: prompt }],
  });
  const text = res.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map(b => b.text)
    .join("");
  return {
    text,
    usage: {
      input_tokens: res.usage.input_tokens,
      output_tokens: res.usage.output_tokens,
    },
    model: modelId,
  };
}
