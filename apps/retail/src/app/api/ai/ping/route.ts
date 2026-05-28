import { NextResponse } from "next/server";
import { isAIEnabled, hasApiKey, getAnthropic, AI_MODELS, DEFAULT_MODEL } from "@/lib/anthropic";

// AI 연결 검증용 (밑작업). 메뉴/UI 에 안 걸린 숨은 라우트.
//   GET /api/ai/ping
//   - AI_ENABLED 아니면 503 (휴면).
//   - 키 없으면 설정 상태만 반환.
//   - 키 있으면 haiku 로 1토큰 핑 → 실제 연결 확인.
export async function GET() {
  if (!isAIEnabled()) {
    return NextResponse.json(
      { enabled: false, message: "AI 비활성 (AI_ENABLED=true 설정 시 동작)" },
      { status: 503 },
    );
  }
  if (!hasApiKey()) {
    return NextResponse.json(
      { enabled: true, hasKey: false, message: "ANTHROPIC_API_KEY 미설정" },
      { status: 200 },
    );
  }

  try {
    const res = await getAnthropic().messages.create({
      model: AI_MODELS.haiku,
      max_tokens: 8,
      messages: [{ role: "user", content: "Reply with exactly: pong" }],
    });
    const text = res.content
      .filter((b): b is { type: "text"; text: string } & typeof b => b.type === "text")
      .map(b => (b as { text: string }).text)
      .join("")
      .trim();
    return NextResponse.json({
      enabled: true,
      hasKey: true,
      ok: true,
      defaultModel: AI_MODELS[DEFAULT_MODEL],
      reply: text,
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ enabled: true, hasKey: true, ok: false, error: message }, { status: 502 });
  }
}
