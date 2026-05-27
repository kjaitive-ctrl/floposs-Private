import { NextRequest, NextResponse } from "next/server";
import { getSupabaseRouteClient } from "@/lib/supabase-server";
import { supabaseAdmin } from "@/lib/supabase-admin";

// 외상 합계 계산 — retail tenant 와 연동된 모든 wholesale customers 의 outstanding 합산.
// 결제수단 변경 시 검증용. /order/me 페이지에서만 호출 (GET ?include=outstanding).
// /samples /products NavBar 등 단순 tenant 조회에선 호출 X (RTT 감축).
async function computeOutstandingTotals(retailTenantId: string) {
  const { data: linked } = await supabaseAdmin
    .from("customers")
    .select("outstanding_balance, outstanding_vat")
    .eq("linked_tenant_id", retailTenantId);

  let supply = 0;
  let vat = 0;
  for (const c of linked ?? []) {
    supply += Number(c.outstanding_balance ?? 0);
    vat += Number(c.outstanding_vat ?? 0);
  }
  return { supply, vat, total_abs: Math.abs(supply) + Math.abs(vat) };
}

// 본인 tenant 정보 조회. UI 헤더/마이페이지용.
// ?include=outstanding query 박혀있을 때만 외상 합산 (RTT 1번 추가). 기본은 tenant 만.
export async function GET(req: NextRequest) {
  const supabase = await getSupabaseRouteClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }

  const tenantId = (user.app_metadata as { tenant_id?: string } | undefined)?.tenant_id;
  if (!tenantId) {
    return NextResponse.json({ error: "tenant_id not set" }, { status: 500 });
  }

  const { data: tenant, error } = await supabaseAdmin
    .from("tenants")
    .select(`
      id, company_name, owner_name, phone, address, business_number, default_payment_method,
      tax_invoice_email, contact_email,
      warehouse_address, warehouse_same_as_office, warehouse_phone,
      store_name, store_url,
      plan_id, subscription_expires_at, cancel_at_period_end,
      subscription_plans(id, name, description, price, billing_cycle, features)
    `)
    .eq("id", tenantId)
    .single();

  if (error || !tenant) {
    return NextResponse.json({ error: error?.message ?? "tenant not found" }, { status: 404 });
  }

  const includeOutstanding = req.nextUrl.searchParams.get("include") === "outstanding";
  const outstanding = includeOutstanding ? await computeOutstandingTotals(tenantId) : null;

  return NextResponse.json({ tenant, outstanding });
}

// 본인 tenant 정보 수정. 매장명/주소/사장님 연락처/결제수단 수정 가능.
// 결제수단 변경 시 — 마이그 179 의 tenants 트리거가 연동된 모든 wholesale customers 도 자동 sync.
// 옛 transactions/orders/영수증/외상은 절대 갱신 X (박제 불변 원칙).
// PIN/휴대폰(아이디) 변경은 v1 미지원.
export async function PATCH(req: NextRequest) {
  const supabase = await getSupabaseRouteClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }

  const tenantId = (user.app_metadata as { tenant_id?: string } | undefined)?.tenant_id;
  if (!tenantId) {
    return NextResponse.json({ error: "tenant_id not set" }, { status: 500 });
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "잘못된 요청입니다." }, { status: 400 });
  }

  const companyName = String(body.company_name ?? "").trim();
  const address = String(body.address ?? "").trim();
  const phone = String(body.phone ?? "").trim();
  const paymentMethod = body.default_payment_method as string | undefined;

  if (!companyName) {
    return NextResponse.json({ error: "업체명을 입력해주세요." }, { status: 400 });
  }

  const updates: Record<string, unknown> = {
    company_name: companyName,
    owner_name: companyName,
    address: address || null,
    phone: phone || null,
  };

  // 마이그 189 신규 필드 — 키가 body 에 있을 때만 update (부분 PATCH 지원)
  if ("tax_invoice_email" in body) {
    updates.tax_invoice_email = String(body.tax_invoice_email ?? "").trim() || null;
  }
  if ("contact_email" in body) {
    updates.contact_email = String(body.contact_email ?? "").trim() || null;
  }
  if ("warehouse_same_as_office" in body) {
    const same = body.warehouse_same_as_office !== false;
    updates.warehouse_same_as_office = same;
    // 동일 체크 시 warehouse_address NULL 정합
    if (same) updates.warehouse_address = null;
  }
  if ("warehouse_address" in body && body.warehouse_same_as_office === false) {
    updates.warehouse_address = String(body.warehouse_address ?? "").trim() || null;
  }
  if ("warehouse_phone" in body) {
    updates.warehouse_phone = String(body.warehouse_phone ?? "").trim() || null;
  }
  if ("store_name" in body) {
    updates.store_name = String(body.store_name ?? "").trim() || null;
  }
  if ("store_url" in body) {
    updates.store_url = String(body.store_url ?? "").trim() || null;
  }

  if (paymentMethod !== undefined) {
    if (!["cash", "transfer", "credit"].includes(paymentMethod)) {
      return NextResponse.json({ error: "결제수단이 올바르지 않습니다." }, { status: 400 });
    }

    // 결제수단 변경 시 외상=0 검증 (사장 정책 2026-05-15: 외상 잔액 있으면 변경 불가)
    // 현재 결제수단과 다를 때만 검증 (같은 값으로 PATCH 하는 케이스 면제)
    const { data: current } = await supabaseAdmin
      .from("tenants")
      .select("default_payment_method")
      .eq("id", tenantId)
      .single();

    if (current?.default_payment_method !== paymentMethod) {
      const outstanding = await computeOutstandingTotals(tenantId);
      if (outstanding.total_abs !== 0) {
        return NextResponse.json(
          {
            error: "외상/매입 잔액이 있어 결제수단을 변경할 수 없습니다. 모든 도매 매장과 정산 후 변경해주세요.",
            outstanding,
          },
          { status: 409 }
        );
      }
    }

    updates.default_payment_method = paymentMethod;
  }

  const { data: updated, error } = await supabaseAdmin
    .from("tenants")
    .update(updates)
    .eq("id", tenantId)
    .select(`
      id, company_name, owner_name, phone, address, business_number, default_payment_method,
      tax_invoice_email, contact_email,
      warehouse_address, warehouse_same_as_office, warehouse_phone,
      store_name, store_url,
      plan_id, subscription_expires_at, cancel_at_period_end
    `)
    .single();

  if (error || !updated) {
    return NextResponse.json({ error: error?.message ?? "수정 실패" }, { status: 500 });
  }

  return NextResponse.json({ tenant: updated });
}
