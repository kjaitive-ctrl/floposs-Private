// 카페24 OAuth + Admin API — ⚠️ 서버 전용 (client_secret 비밀). api/cafe24/* 에서만 import.
// 절차: authorize redirect → callback(code) → token 교환 → 박제 → API 호출(Bearer).
// [[project_cafe24_export_design]] [[feedback_presigned_url_exception]]

import { createClient } from "@supabase/supabase-js";

// supabase-admin 직접 생성 (순환 import 방지 — supabase-admin.ts 가 이 파일 import 안 하므로 OK)
const _admin = () => createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { autoRefreshToken: false, persistSession: false } }
);

const CLIENT_ID = process.env.CAFE24_CLIENT_ID ?? "";
const CLIENT_SECRET = process.env.CAFE24_CLIENT_SECRET ?? "";
const REDIRECT_URI = process.env.CAFE24_REDIRECT_URI ?? "";
// 필요한 최소 권한 (상품 + 상품분류 읽기/쓰기)
const SCOPES = "mall.read_product,mall.write_product,mall.read_category,mall.write_category";
// X-Cafe24-Api-Version (YYYY-MM-DD). 테스트 시 개발자센터 최신 버전으로 확정.
const API_VERSION = process.env.CAFE24_API_VERSION || "2026-03-01";

const baseUrl = (mallId: string) => `https://${mallId}.cafe24api.com`;
const basicAuth = () => "Basic " + Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString("base64");

export function buildAuthorizeUrl(mallId: string, state: string): string {
  const p = new URLSearchParams({
    response_type: "code",
    client_id: CLIENT_ID,
    state,
    redirect_uri: REDIRECT_URI,
    scope: SCOPES,
  });
  return `${baseUrl(mallId)}/api/v2/oauth/authorize?${p.toString()}`;
}

export interface Cafe24Token {
  access_token: string;
  refresh_token: string;
  expires_at: string;                 // ISO (access, ~2h)
  refresh_token_expires_at?: string;  // ISO (~2주)
  scopes?: string[];
  mall_id?: string;
}

// res.json() 이 HTML(WAF/점검페이지/리다이렉트 등)을 만나면 "Unexpected token '<'" 라는
// 정체불명 SyntaxError만 남기고 실제 원인(상태코드/응답 앞부분)이 사라짐 — text로 받아 직접 파싱해 진단 가능하게.
async function parseJsonOrThrow<T>(res: Response, context: string): Promise<T> {
  const text = await res.text();
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`${context} ${res.status}: JSON 아닌 응답 — ${text.slice(0, 300)}`);
  }
}

async function tokenRequest(mallId: string, body: Record<string, string>): Promise<Cafe24Token> {
  const res = await fetch(`${baseUrl(mallId)}/api/v2/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Authorization: basicAuth() },
    body: new URLSearchParams(body).toString(),
  });
  if (!res.ok) throw new Error(`cafe24 token ${res.status}: ${await res.text()}`);
  return parseJsonOrThrow<Cafe24Token>(res, "cafe24 token");
}

// 인증코드 → 토큰
export function exchangeCodeForToken(mallId: string, code: string): Promise<Cafe24Token> {
  return tokenRequest(mallId, { grant_type: "authorization_code", code, redirect_uri: REDIRECT_URI });
}
// refresh → 새 access token
export function refreshAccessToken(mallId: string, refreshToken: string): Promise<Cafe24Token> {
  return tokenRequest(mallId, { grant_type: "refresh_token", refresh_token: refreshToken });
}

// 유효한 access token 반환. null = 미연동 or refresh 실패.
export interface ValidToken { mall_id: string; access_token: string; }

// expires_at 필드가 ISO string / Unix초 / Unix ms 어느 형식이든 ms 반환
function parseExpiresAtMs(raw: unknown): number {
  if (!raw) return 0;
  if (typeof raw === "number") return raw > 1e12 ? raw : raw * 1000;
  const ts = Date.parse(String(raw));
  if (!isNaN(ts)) return ts;
  const n = Number(raw);
  return isNaN(n) ? 0 : (n > 1e12 ? n : n * 1000);
}

export async function getValidTokenForTenant(tenantId: string, forceRefresh = false): Promise<ValidToken | null> {
  const db = _admin();
  const { data } = await db
    .from("tenant_cafe24_tokens")
    .select("mall_id, access_token, refresh_token, expires_at")
    .eq("retail_tenant_id", tenantId)
    .single();
  if (!data) return null;

  const expiresMs = parseExpiresAtMs(data.expires_at);
  const needsRefresh = forceRefresh || expiresMs < Date.now() + 10 * 60_000;

  if (needsRefresh) {
    try {
      const t = await refreshAccessToken(data.mall_id, data.refresh_token);
      // expires_at을 항상 안전한 ISO string으로 저장 (cafe24 응답 형식 무관)
      const newExpiresAt = new Date(parseExpiresAtMs(t.expires_at) || Date.now() + 2 * 60 * 60_000).toISOString();
      await db.from("tenant_cafe24_tokens").update({
        access_token: t.access_token,
        expires_at: newExpiresAt,
        ...(t.refresh_token ? { refresh_token: t.refresh_token } : {}),
        updated_at: new Date().toISOString(),
      }).eq("retail_tenant_id", tenantId);
      return { mall_id: data.mall_id, access_token: t.access_token };
    } catch { return null; }
  }
  return { mall_id: data.mall_id, access_token: data.access_token };
}

// Admin API 호출 (Bearer + 버전 헤더). path 예: "products", "categories"
export async function cafe24Api<T = unknown>(
  mallId: string, accessToken: string, method: string, path: string, body?: unknown
): Promise<T> {
  const res = await fetch(`${baseUrl(mallId)}/api/v2/admin/${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      "X-Cafe24-Api-Version": API_VERSION,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`cafe24 api ${method} ${path} ${res.status}: ${await res.text()}`);
  return parseJsonOrThrow<T>(res, `cafe24 api ${method} ${path}`);
}

// 이미지 Buffer → 순수 base64(접두어 없음) → POST /products/{product_no}/images 로 업로드
// cafe24가 CDN 업로드 + 상품 매핑을 한 번에 처리하는 공식 API
// 이미지를 cafe24 CDN에 업로드하고 CDN URL을 반환
// POST /products/{product_no}/images — CDN 업로드 + 대표이미지 자동 리사이징
export async function cafe24UploadImageToProduct(
  mallId: string, accessToken: string, productNo: number,
  imageBuffer: Buffer, imageName = "image.jpg",
): Promise<{ cdnUrl: string; raw: Record<string, string> }> {
  const base64 = imageBuffer.toString("base64");
  const data = await cafe24Api<{ image?: Record<string, string> }>(
    mallId, accessToken, "POST", `products/${productNo}/images`, {
      request: {
        image_upload_type: "A",
        image: base64,
        image_name: imageName,
        detail_image: base64,
      },
    },
  );
  const img = data.image ?? {};
  const cdnUrl = img.detail_image ?? img.big_image ?? img.image_url ?? img.url
    ?? Object.values(img).find((v): v is string => typeof v === "string" && v.startsWith("http"))
    ?? "";
  return { cdnUrl, raw: img };
}
