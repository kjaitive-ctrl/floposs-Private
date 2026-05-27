import { NextRequest, NextResponse } from "next/server";
import { getSupabaseRouteClient } from "@/lib/supabase-server";
import { supabaseAdmin } from "@/lib/supabase-admin";

// 외부 주문 포털 핵심: customers UPSERT (linked_tenant_id 박제) + orders INSERT + order_items INSERT.
//
// 정책 (사장 확정 2026-05-15):
//   - retail user 본인 인증 필수
//   - wholesale_tenant_id 가 active 이기만 하면 됨 — 영업 중이 아니어도 staging 큐에 쌓임
//   - 영업세션 박제는 사장이 [처리!] 누르는 시점에 derived order/transactions 에 (071 trigger 자동)
//   - orders.total_amount = 0, order_items.unit_price = 0 (단가는 wholesale 처리 시점에 결정)
//   - customers dedupe: tenant_id=wholesale AND linked_tenant_id=retail
//   - 마이그 176 (orders.biz_session_id NULL 허용 + external_inbox 외 차단 trigger) 의존
export async function POST(req: NextRequest) {
  const supabase = await getSupabaseRouteClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }

  const retailTenantId = (user.app_metadata as { tenant_id?: string } | undefined)?.tenant_id;
  if (!retailTenantId) {
    return NextResponse.json({ error: "tenant_id not set" }, { status: 500 });
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "잘못된 요청입니다." }, { status: 400 });
  }

  const wholesaleTenantId = String(body.wholesale_tenant_id ?? "").trim();
  const rawItems = Array.isArray(body.items) ? body.items : [];
  if (!wholesaleTenantId) {
    return NextResponse.json({ error: "도매 매장을 선택해주세요." }, { status: 400 });
  }

  const items = rawItems
    .map((it): { variant_id: string; quantity: number } | null => {
      if (typeof it !== "object" || it === null) return null;
      const variantId = String((it as { variant_id?: unknown }).variant_id ?? "").trim();
      const qty = Number((it as { quantity?: unknown }).quantity ?? 0);
      if (!variantId || !Number.isFinite(qty) || qty <= 0) return null;
      return { variant_id: variantId, quantity: Math.floor(qty) };
    })
    .filter((x): x is { variant_id: string; quantity: number } => x !== null);

  if (items.length === 0) {
    return NextResponse.json({ error: "주문할 상품/수량을 입력해주세요." }, { status: 400 });
  }

  // 1) retail tenant 정보 (customer 박제용 — retail 마스터 필드 전부)
  const { data: retailTenant, error: retailErr } = await supabaseAdmin
    .from("tenants")
    .select("id, company_name, owner_name, phone, address, business_number, default_payment_method")
    .eq("id", retailTenantId)
    .single();

  if (retailErr || !retailTenant) {
    return NextResponse.json({ error: "본인 매장 정보를 찾을 수 없습니다." }, { status: 400 });
  }

  // 2) wholesale tenant 확인
  const { data: wholesale, error: wsErr } = await supabaseAdmin
    .from("tenants")
    .select("id, company_name, tenant_type, is_active")
    .eq("id", wholesaleTenantId)
    .single();

  if (wsErr || !wholesale || wholesale.tenant_type !== "wholesale" || !wholesale.is_active) {
    return NextResponse.json({ error: "도매 매장을 찾을 수 없습니다." }, { status: 404 });
  }

  // 3) variant_id 들이 모두 해당 wholesale 의 active variant 인지 검증 + 단가 매핑
  // (영업 중 검증은 마이그 176 으로 제거 — staging 은 영업 무관 수신, 처리 시점에 071 trigger 가 활성 세션 박제)
  // 단가는 서버 측에서 wholesale 측 products.base_price/sale_price 로 박제. retail 측 입력 X (클라이언트 조작 방지).
  // SaleForm 패턴 그대로: variant.is_sale 이면 sale_price, 아니면 base_price
  const variantIds = items.map((it) => it.variant_id);
  const { data: variants, error: varErr } = await supabaseAdmin
    .from("product_variants")
    .select("id, product_id, is_active, is_sale, products!inner(tenant_id, is_active, base_price, sale_price)")
    .in("id", variantIds);

  if (varErr) {
    return NextResponse.json({ error: varErr.message }, { status: 500 });
  }

  // variant_id → unit_price 매핑
  const variantPriceMap = new Map<string, number>();
  for (const v of variants ?? []) {
    const prod = v.products as unknown as {
      tenant_id: string;
      is_active: boolean;
      base_price: number | null;
      sale_price: number | null;
    } | null;
    if (!v.is_active || !prod || prod.tenant_id !== wholesaleTenantId || !prod.is_active) continue;
    const basePrice = Number(prod.base_price ?? 0);
    const salePrice = prod.sale_price == null ? null : Number(prod.sale_price);
    const unitPrice = v.is_sale && salePrice != null && salePrice > 0 ? salePrice : basePrice;
    variantPriceMap.set(v.id, unitPrice);
  }

  const invalidItems = items.filter((it) => !variantPriceMap.has(it.variant_id));
  if (invalidItems.length > 0) {
    return NextResponse.json(
      { error: "유효하지 않은 상품/옵션이 포함되어 있습니다." },
      { status: 400 }
    );
  }

  // 4) customers UPSERT — (tenant_id, linked_tenant_id) 조합으로 dedupe
  const { data: existingCustomer } = await supabaseAdmin
    .from("customers")
    .select("id")
    .eq("tenant_id", wholesaleTenantId)
    .eq("linked_tenant_id", retailTenantId)
    .limit(1)
    .maybeSingle();

  let customerId: string;
  if (existingCustomer) {
    customerId = existingCustomer.id;
  } else {
    // default_payment_method + include_vat 둘 다 박제 필수
    //   - default_payment_method: 처리 흐름이 customers.default_payment_method 기반으로 결제수단 결정
    //   - include_vat: 마이그 171 정책 — credit 거래처만 외상에 vat 포함 (cash/transfer 는 supply only).
    //     DB default=true 라서 박제 누락 시 cash 거래처도 vat 외상 잡히는 버그 발생.
    const dpm = retailTenant.default_payment_method ?? "credit";
    // retail 마스터 컬럼 전부 박제 (정공법 — 미래 retail 가입 폼 확장 시 컬럼 추가만으로 정합)
    const { data: newCustomer, error: custErr } = await supabaseAdmin
      .from("customers")
      .insert({
        tenant_id: wholesaleTenantId,
        linked_tenant_id: retailTenantId,
        company_name: retailTenant.company_name,
        owner_name: retailTenant.owner_name,
        phone: retailTenant.phone,
        address: retailTenant.address,
        business_number: retailTenant.business_number,
        default_payment_method: dpm,
        include_vat: dpm === "credit",
        source: "external_order",
        is_active: true,
      })
      .select("id")
      .single();

    if (custErr || !newCustomer) {
      return NextResponse.json({ error: custErr?.message ?? "거래처 자동 등록 실패" }, { status: 500 });
    }
    customerId = newCustomer.id;
  }

  // 5) order_number 생성 — wholesale tenant 의 당일 마지막 순번 +1
  //    형식: EXT-YYMMDD-NNNN (외부 주문 식별자 + 일자 + 순번)
  const today = new Date();
  const yymmdd =
    today.getFullYear().toString().slice(2) +
    String(today.getMonth() + 1).padStart(2, "0") +
    String(today.getDate()).padStart(2, "0");
  const prefix = `EXT-${yymmdd}-`;

  const { data: lastOrder } = await supabaseAdmin
    .from("orders")
    .select("order_number")
    .eq("tenant_id", wholesaleTenantId)
    .like("order_number", `${prefix}%`)
    .order("order_number", { ascending: false })
    .limit(1);

  const lastSeq = lastOrder?.[0]
    ? parseInt(lastOrder[0].order_number.split("-")[2], 10) || 0
    : 0;
  const orderNumber = `${prefix}${String(lastSeq + 1).padStart(4, "0")}`;

  // 6) 합계 계산 (staging) — order_items.unit_price = variant default 단가 박제
  //    SaleForm 패턴: total = supply, vat 박제는 처리 시점(issue_receipt_snapshot)에서.
  //    메모리 [feedback_vat_absolute_principles] — vat 은 영수증 박제 시점이 source of truth.
  const totalAmount = items.reduce(
    (s, it) => s + it.quantity * (variantPriceMap.get(it.variant_id) ?? 0),
    0
  );

  // 7) orders INSERT (staging — biz_session_id NULL, order_source='external_inbox')
  //    071 trigger 가 활성 세션 있으면 자동 채움, 없으면 NULL 그대로 — 마이그 176 의 enforce trigger 가 external_inbox 면 통과시킴
  const paymentMethod = retailTenant.default_payment_method ?? "credit";

  const { data: order, error: orderErr } = await supabaseAdmin
    .from("orders")
    .insert({
      tenant_id: wholesaleTenantId,
      customer_id: customerId,
      customer_name: retailTenant.company_name,
      order_number: orderNumber,
      order_type: "retail_b2b",
      order_source: "external_inbox",
      payment_method: paymentMethod,
      status: "confirmed",
      total_amount: totalAmount,
      vat_amount: 0,
      paid_amount: 0,
      outstanding_amount: 0,
    })
    .select("id")
    .single();

  if (orderErr || !order) {
    return NextResponse.json({ error: orderErr?.message ?? "주문 등록 실패" }, { status: 500 });
  }

  // 8) order_items INSERT (단가 + 합계 박제)
  const { error: itemsErr } = await supabaseAdmin.from("order_items").insert(
    items.map((it) => {
      const unitPrice = variantPriceMap.get(it.variant_id) ?? 0;
      return {
        order_id: order.id,
        variant_id: it.variant_id,
        quantity: it.quantity,
        original_quantity: it.quantity,
        remaining_qty: it.quantity,
        unit_price: unitPrice,
        total_price: it.quantity * unitPrice,
        status: "unshipped",
        process_type: "ordered",
        is_sample: false,
      };
    })
  );

  if (itemsErr) {
    await supabaseAdmin.from("orders").delete().eq("id", order.id);
    return NextResponse.json({ error: itemsErr.message }, { status: 500 });
  }

  // 8) retail tenant.last_order_at 갱신
  await supabaseAdmin
    .from("tenants")
    .update({ last_order_at: new Date().toISOString() })
    .eq("id", retailTenantId);

  return NextResponse.json({
    success: true,
    order_id: order.id,
    order_number: orderNumber,
  });
}
