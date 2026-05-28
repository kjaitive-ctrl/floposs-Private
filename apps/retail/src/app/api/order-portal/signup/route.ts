import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-admin";
import {
  isValidPhone,
  isValidPin,
  normalizePhone,
  phoneToEmail,
  type PaymentMethod,
} from "@/lib/orderPortal";

// retail v2 가입 (마이그 189).
// 입력:
//   - 필수: phone, pin, company_name(=업체명), default_payment_method
//   - 선택: address(=사무실주소), phone2(=사장님 연락처), 신규 6필드
// 동작:
//   1) dummy email Auth signUp
//   2) tenants(tenant_type='retail') INSERT — 신규 필드 박제
//   3) Free Beta 플랜 자동 박제 (가장 싼 active retail 플랜) + expires_at = now()+3개월
//   4) users INSERT + app_metadata 박제
export async function POST(req: NextRequest) {
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "잘못된 요청입니다." }, { status: 400 });
  }

  // 기본 필드
  const phone = String(body.phone ?? "").trim();
  const pin = String(body.pin ?? "").trim();
  const companyName = String(body.company_name ?? "").trim();   // 업체명(상호)
  const ownerName = String(body.owner_name ?? "").trim();        // 대표자명
  const businessNumber = String(body.business_number ?? "").trim(); // 사업자등록번호
  const address = String(body.address ?? "").trim();             // 사무실주소
  const representativePhone = String(body.representative_phone ?? "").trim();
  const defaultPaymentMethod = body.default_payment_method as PaymentMethod;

  // 마이그 189 신규
  const taxInvoiceEmail      = String(body.tax_invoice_email ?? "").trim();
  const contactEmail         = String(body.contact_email ?? "").trim();
  const warehouseSameAsOffice = body.warehouse_same_as_office !== false; // default true
  const warehouseAddress     = String(body.warehouse_address ?? "").trim();
  const warehousePhone       = String(body.warehouse_phone ?? "").trim();
  const storeName            = String(body.store_name ?? "").trim();     // 쇼핑몰/매장명
  const storeUrl             = String(body.store_url ?? "").trim();

  // ── 검증 ──
  if (!isValidPhone(phone)) {
    return NextResponse.json({ error: "휴대폰 번호를 정확히 입력해주세요 (010-XXXX-XXXX)." }, { status: 400 });
  }
  if (!isValidPin(pin)) {
    return NextResponse.json({ error: "비밀번호는 숫자 4자리로 설정해주세요." }, { status: 400 });
  }
  if (!companyName) {
    return NextResponse.json({ error: "업체명을 입력해주세요." }, { status: 400 });
  }
  if (!["cash", "transfer", "credit"].includes(defaultPaymentMethod)) {
    return NextResponse.json({ error: "결제수단을 선택해주세요." }, { status: 400 });
  }

  const phoneDigits = normalizePhone(phone);
  const email = phoneToEmail(phone);

  // 1) Auth 계정 생성
  const { data: authData, error: authError } = await supabaseAdmin.auth.admin.createUser({
    email,
    password: pin,
    email_confirm: true,
    app_metadata: { role: "tenant_admin", user_type: "retail" },
  });
  if (authError) {
    const msg =
      authError.message.includes("already registered") ||
      authError.message.includes("already been registered")
        ? "이미 가입된 휴대폰 번호입니다."
        : authError.message;
    return NextResponse.json({ error: msg }, { status: 400 });
  }

  // 2) Free Beta 플랜 자동 박제 (가장 싼 active retail 플랜 = 베타)
  //    플랜 미설치 시 plan_id=null 로 가입 진행 (admin 가시성 + 가드 로직이 비치킹)
  const { data: betaPlan } = await supabaseAdmin
    .from("subscription_plans")
    .select("id")
    .eq("vertical", "retail")
    .eq("is_active", true)
    .order("price", { ascending: true })
    .limit(1)
    .maybeSingle();

  const expiresAt = new Date();
  expiresAt.setMonth(expiresAt.getMonth() + 3);

  // 3) tenants INSERT (tenant_type='retail')
  const { data: tenant, error: tenantError } = await supabaseAdmin
    .from("tenants")
    .insert({
      tenant_type: "retail",
      company_name: companyName,
      owner_name: ownerName || companyName,   // 미입력 시 상호로 fallback
      business_number: businessNumber || null,
      phone: representativePhone || phoneDigits,
      address: address || null,
      default_payment_method: defaultPaymentMethod,
      // 마이그 189 신규 필드
      tax_invoice_email: taxInvoiceEmail || null,
      contact_email: contactEmail || null,
      warehouse_same_as_office: warehouseSameAsOffice,
      warehouse_address: warehouseSameAsOffice ? null : (warehouseAddress || null),
      warehouse_phone: warehousePhone || null,
      store_name: storeName || null,
      store_url: storeUrl || null,
      // 구독 자동 박제 (베타 플랜 있으면)
      plan_id: betaPlan?.id ?? null,
      subscription_expires_at: betaPlan ? expiresAt.toISOString() : null,
      is_active: true,
      status: "active",   // retail 자가가입 = 자동 활성 (승인 개념 없음, 진입 가드는 구독 만료만)
    })
    .select("id")
    .single();

  if (tenantError) {
    await supabaseAdmin.auth.admin.deleteUser(authData.user.id);
    return NextResponse.json({ error: tenantError.message }, { status: 400 });
  }

  // 4) users INSERT
  const { error: userError } = await supabaseAdmin.from("users").insert({
    id: authData.user.id,
    tenant_id: tenant.id,
    email,
    name: companyName,
    phone: phoneDigits,
    role: "tenant_admin",
  });

  if (userError) {
    await supabaseAdmin.auth.admin.deleteUser(authData.user.id);
    await supabaseAdmin.from("tenants").delete().eq("id", tenant.id);
    return NextResponse.json({ error: userError.message }, { status: 400 });
  }

  // 5) app_metadata 에 tenant_id 박기 (JWT claim)
  const { error: metaError } = await supabaseAdmin.auth.admin.updateUserById(authData.user.id, {
    app_metadata: { role: "tenant_admin", user_type: "retail", tenant_id: tenant.id },
  });
  if (metaError) {
    console.error("[order-portal/signup] app_metadata 업데이트 실패:", metaError);
  }

  return NextResponse.json({ success: true, tenant_id: tenant.id });
}
