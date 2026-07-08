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

// 유효한 access token 반환 (만료 5분 전이면 자동 refresh). null = 미연동 or refresh 실패.
export interface ValidToken { mall_id: string; access_token: string; }

export async function getValidTokenForTenant(tenantId: string): Promise<ValidToken | null> {
  const db = _admin();
  const { data } = await db
    .from("tenant_cafe24_tokens")
    .select("mall_id, access_token, refresh_token, expires_at")
    .eq("retail_tenant_id", tenantId)
    .single();
  if (!data) return null;

  if (new Date(data.expires_at).getTime() < Date.now() + 5 * 60_000) {
    try {
      const t = await refreshAccessToken(data.mall_id, data.refresh_token);
      await db.from("tenant_cafe24_tokens").update({
        access_token: t.access_token,
        expires_at: t.expires_at,
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
  return res.json();
}

// 1단계: 이미지 Buffer → base64(data URI) → cafe24 스토리지 업로드 → CDN URL 반환
// POST /api/v2/admin/products/images { request: { image: "data:image/jpeg;base64,...", image_name: "..." } }
export async function cafe24UploadImageBase64(
  mallId: string, accessToken: string, imageBuffer: Buffer, imageName = "image.jpg",
): Promise<string> {
  const mime = imageName.match(/\.png$/i) ? "image/png" : "image/jpeg";
  const dataUri = `data:${mime};base64,${imageBuffer.toString("base64")}`;
  const data = await cafe24Api<{ image?: Record<string, string> }>(
    mallId, accessToken, "POST", "products/images",
    { request: { image: dataUri, image_name: imageName } },
  );
  // 응답 필드 후보: big_image, detail_image, url, image_url
  const img = data.image ?? {};
  const url = img.big_image ?? img.detail_image ?? img.image_url ?? img.url
    ?? Object.values(img).find(v => typeof v === "string" && v.startsWith("http"));
  if (!url) throw new Error(`cafe24 이미지 업로드 실패: ${JSON.stringify(data)}`);
  return url;
}

// 2단계: cafe24 CDN URL들을 상품에 등록
// POST /api/v2/admin/products/{product_no}/images { request: { detail_image, big_image, list_image, small_image } }
export async function cafe24LinkImagesToProduct(
  mallId: string, accessToken: string, productNo: number, cdnUrl: string,
): Promise<void> {
  await cafe24Api(
    mallId, accessToken, "POST", `products/${productNo}/images`, {
      shop_no: 1,
      request: {
        detail_image: cdnUrl,
        big_image: cdnUrl,
        list_image: cdnUrl,
        small_image: cdnUrl,
      },
    },
  );
}
