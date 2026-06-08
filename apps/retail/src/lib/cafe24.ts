// 카페24 OAuth + Admin API — ⚠️ 서버 전용 (client_secret 비밀). api/cafe24/* 에서만 import.
// 절차: authorize redirect → callback(code) → token 교환 → 박제 → API 호출(Bearer).
// [[project_cafe24_export_design]] [[feedback_presigned_url_exception]]

const CLIENT_ID = process.env.CAFE24_CLIENT_ID ?? "";
const CLIENT_SECRET = process.env.CAFE24_CLIENT_SECRET ?? "";
const REDIRECT_URI = process.env.CAFE24_REDIRECT_URI ?? "";
// 필요한 최소 권한 (상품 + 상품분류 읽기/쓰기)
const SCOPES = "mall.read_product,mall.write_product,mall.read_category,mall.write_category";
// X-Cafe24-Api-Version (YYYY-MM-DD). 테스트 시 개발자센터 최신 버전으로 확정.
const API_VERSION = process.env.CAFE24_API_VERSION || "2025-06-01";

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

async function tokenRequest(mallId: string, body: Record<string, string>): Promise<Cafe24Token> {
  const res = await fetch(`${baseUrl(mallId)}/api/v2/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Authorization: basicAuth() },
    body: new URLSearchParams(body).toString(),
  });
  if (!res.ok) throw new Error(`cafe24 token ${res.status}: ${await res.text()}`);
  return res.json();
}

// 인증코드 → 토큰
export function exchangeCodeForToken(mallId: string, code: string): Promise<Cafe24Token> {
  return tokenRequest(mallId, { grant_type: "authorization_code", code, redirect_uri: REDIRECT_URI });
}
// refresh → 새 access token
export function refreshAccessToken(mallId: string, refreshToken: string): Promise<Cafe24Token> {
  return tokenRequest(mallId, { grant_type: "refresh_token", refresh_token: refreshToken });
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
  return res.json();
}
