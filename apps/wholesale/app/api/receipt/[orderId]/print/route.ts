import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { buildReceiptDoc, buildSampleDoc, buildPendingDoc } from "@/app/dashboard/_components/receipt/template";
import { toEscPos } from "@/app/dashboard/_components/receipt/toEscPos";
import type {
  ReceiptData, SampleData, PendingData, PendingItem, ProductExtra,
  ReceiptOverrides, FormOptions,
} from "@/app/dashboard/_components/receipt/types";
import { METHOD_LABELS, formatKstDateOnly, formatKstDateTime, formatKstShipDate } from "@/lib/format";

// 영수증 출력용 ESC/POS bytes 생성.
// 클라이언트는 받은 base64 bytes 를 QZ Tray 로 프린터에 전송.
//
// GET  /api/receipt/[orderId]/print  → { bytes: base64, doc: ReceiptDoc(미리보기용) }

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ orderId: string }> }
) {
  const { orderId } = await params;

  // 인증 — Bearer 토큰 → tenant_id 확인
  const authHeader = req.headers.get("authorization");
  const token = authHeader?.replace("Bearer ", "");
  if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: { user } } = await supabaseAdmin.auth.getUser(token);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const meta = user.app_metadata as { role?: string; tenant_id?: string };
  const tenantId = meta?.tenant_id;
  if (!tenantId) return NextResponse.json({ error: "missing tenant" }, { status: 403 });

  // 주문 + 항목 + 거래처 + tenant 사업자정보 조회
  const [{ data: order }, { data: tenant }] = await Promise.all([
    supabaseAdmin
      .from("orders")
      .select(`
        id, order_number, total_amount, vat_amount, outstanding_amount,
        payment_method, memo, created_at, biz_session_id, order_source, derived_from_order_id,
        receipt_no, receipt_issued_at, receipt_prev_balance, receipt_day_total,
        receipt_payment_method, receipt_payment_amount, receipt_post_balance,
        receipt_print_count,
        receipt_supply_amount, receipt_vat_amount, receipt_total_amount, receipt_vat_in_payment,
        customer:customer_id ( company_name ),
        order_items ( id, quantity, unit_price, shipped_qty, remaining_qty,
                      process_type, status, is_sample, is_exchange,
                      product_variants ( color, size,
                        products ( name, material_composition ) ) )
      `)
      .eq("id", orderId)
      .eq("tenant_id", tenantId)
      .maybeSingle(),
    supabaseAdmin
      .from("tenants")
      .select(`company_name, business_number, owner_name, phone, address, biz_address,
               business_type, business_category,
               main_bank_name, main_bank_account, main_bank_holder,
               sub_bank_name, sub_bank_account, sub_bank_holder,
               receipt_text_overrides`)
      .eq("id", tenantId)
      .maybeSingle(),
  ]);

  if (!order)  return NextResponse.json({ error: "주문을 찾을 수 없습니다" }, { status: 404 });
  if (!tenant) return NextResponse.json({ error: "사업자 정보 누락" }, { status: 404 });

  // 영업세션 내 영수증 발행 순번 — 박제값 receipt_no 가 있는 주문 중 created_at 까지 카운트
  let sessionSeq: number | null = null;
  if (order.biz_session_id && order.receipt_no) {
    const { count } = await supabaseAdmin
      .from("orders")
      .select("id", { count: "exact", head: true })
      .eq("biz_session_id", order.biz_session_id as string)
      .not("receipt_no", "is", null)
      .lte("created_at", order.created_at as string);
    sessionSeq = count ?? null;
  }

  // 항목 추출 (출고된 수량만)
  const orderItems = (order.order_items as unknown as Array<{
    quantity: number; unit_price: number; shipped_qty: number; remaining_qty: number;
    process_type: string | null; status: string;
    is_sample: boolean; is_exchange: boolean;
    product_variants: { color: string | null; size: string | null;
                        products: { name: string; material_composition: Record<string, number> | null } | null } | null;
  }>);

  // 음수 derived 영수증 (item qty/amount 음수 표기):
  //   - return  : 반품 (order_source='return')
  //   - backorder_release: 미송해제 (148, order_source='backorder_release')
  const orderSource = (order.order_source as string | null) ?? "";
  const isNegative = orderSource === "return" || orderSource === "backorder_release";
  const items = orderItems
    .filter(i => !i.is_sample && !i.is_exchange)
    .map(i => {
      const productName = i.product_variants?.products?.name ?? "(상품)";
      const opt = [i.product_variants?.color, i.product_variants?.size].filter(Boolean).join(" ");
      const rawQty = (i.shipped_qty ?? 0)
                + (i.process_type === "backorder" && i.status === "unshipped" ? (i.remaining_qty ?? 0) : 0);
      const qty = isNegative ? -rawQty : rawQty;
      return {
        name:      productName,
        qty,
        unitPrice: Number(i.unit_price),
        amount:    qty * Number(i.unit_price),
        option:    opt || undefined,
        isBackorder: i.process_type === "backorder",
      };
    })
    .filter(it => it.qty !== 0);

  // 양식 분기 — order_source 기반 단일 매핑 (관리자 확정 매트릭스 2026-05-11):
  //   - backorder_ship : 미송 출고 (발송)  → 발송/미발송내역
  //   - is_sample only : 샘플 출고          → 샘플전표
  //   - 그 외 (출고/보류출고/미송등록/샘플결제/반품/미송해제) → 영수증
  // 호출처 어디서든 동일 orderId 면 동일 양식 출력 (카톡복사도 같은 이미지).
  const isSampleOnly = orderItems.length > 0 && orderItems.every(i => i.is_sample);
  const isBackorderShip = orderSource === "backorder_ship";

  // productExtras — 옵션/혼용율 푸터 (showOptions / showMaterial 켰을 때 표시).
  // 샘플 전표는 라인 자체가 is_sample → 그 라인 기준으로 extras 생성. 그 외는 비-샘플 라인 기준.
  const extrasSource = isSampleOnly
    ? orderItems.filter(i => !i.is_exchange)
    : orderItems.filter(i => !i.is_sample && !i.is_exchange);
  const productExtras = computeProductExtras(extrasSource);

  // 159 VAT 정공법: 박제값 우선 사용 (P1 source of truth).
  // 박제 없으면 (이전 영수증) 폴백 동적 계산.
  const hasReceiptSnapshot = order.receipt_supply_amount !== null && order.receipt_supply_amount !== undefined;
  const supply = hasReceiptSnapshot
    ? Number(order.receipt_supply_amount)
    : items.reduce((s, it) => s + it.amount, 0);
  const vat = hasReceiptSnapshot
    ? Number(order.receipt_vat_amount ?? 0)
    : Number(order.vat_amount ?? 0);
  const total = hasReceiptSnapshot
    ? Number(order.receipt_total_amount ?? supply + vat)
    : Number(order.total_amount ?? supply + vat);
  const vatInPayment = hasReceiptSnapshot
    ? !!order.receipt_vat_in_payment
    : Number(order.vat_amount ?? 0) > 0;
  const customerObj = order.customer as unknown as { company_name: string } | null;

  // 박제 / 재발행
  const hasSnapshot = !!order.receipt_no;
  const printCount = Number(order.receipt_print_count ?? 0);
  const isReprint = hasSnapshot && printCount >= 1;

  // 영수증 모드 결정 (사장 정책 2026-05-06 + 148 미송해제):
  //   - return (반품/교환 derived) → mode='return' (도장 "반품")
  //   - backorder_release (미송해제 derived, 148) → mode='return' (음수 영수증 — 도장 동일 "반품")
  //   - 그 외 모든 출고 (일반/미송 출고/보류 출고/샘플 결제 등) → mode='normal'
  const receiptMode: "normal" | "return" =
    (orderSource === "return" || orderSource === "backorder_release") ? "return" : "normal";

  // derived 주문이면 원주문의 미발송 잔량 fetch (잔량 박스 표시용)
  let unshippedFromOriginal: Array<{ name: string; qty: number; option?: string }> | undefined;
  const derivedFromId = order.derived_from_order_id as string | null;
  if (derivedFromId) {
    const { data: origItems } = await supabaseAdmin
      .from("order_items")
      .select(`quantity, shipped_qty, remaining_qty, process_type, status, is_sample, is_exchange,
               product_variants ( color, size, products ( name ) )`)
      .eq("order_id", derivedFromId);
    if (origItems) {
      type Row = {
        quantity: number; shipped_qty: number; remaining_qty: number;
        process_type: string | null; status: string;
        is_sample: boolean; is_exchange: boolean;
        product_variants: { color: string | null; size: string | null;
                            products: { name: string } | null } | null;
      };
      const remaining = (origItems as unknown as Row[])
        .filter(r => !r.is_sample && !r.is_exchange)
        .filter(r => r.status === "unshipped" && (r.process_type === "backorder" || r.process_type === "hold"))
        .map(r => {
          const opt = [r.product_variants?.color, r.product_variants?.size].filter(Boolean).join(" ");
          return {
            name:   r.product_variants?.products?.name ?? "(상품)",
            qty:    Number(r.remaining_qty ?? 0),
            option: opt || undefined,
          };
        })
        .filter(r => r.qty > 0);
      if (remaining.length > 0) unshippedFromOriginal = remaining;
    }
  }

  const bankInfo = tenant.main_bank_name && tenant.main_bank_account ? {
    name:    tenant.main_bank_name as string,
    account: tenant.main_bank_account as string,
    holder:  (tenant.main_bank_holder as string) ?? "",
  } : null;
  const bankInfo2 = tenant.sub_bank_name && tenant.sub_bank_account ? {
    name:    tenant.sub_bank_name as string,
    account: tenant.sub_bank_account as string,
    holder:  (tenant.sub_bank_holder as string) ?? "",
  } : null;
  const customerName = customerObj?.company_name ?? "(거래처)";
  const docDate      = formatKstDateTime((order.receipt_issued_at as string) ?? (order.created_at as string));
  const shipDate     = formatKstShipDate(order.created_at as string);

  const overrides = (tenant.receipt_text_overrides as ReceiptOverrides | null) ?? {};
  const businessInfo = {
    businessName:     tenant.company_name as string,
    businessNumber:   (tenant.business_number as string | null) ?? null,
    ceoName:          (tenant.owner_name as string | null) ?? null,
    phone:            (tenant.phone as string | null) ?? null,
    address:          (tenant.biz_address as string | null) ?? (tenant.address as string | null) ?? null,
    businessType:     (tenant.business_type as string | null) ?? null,
    businessCategory: (tenant.business_category as string | null) ?? null,
    bankInfo, bankInfo2,
  };

  let doc;
  if (isBackorderShip) {
    // 미송 출고 (발송/미발송내역 양식). 잔액박스 X, 출고 라인만 표시.
    const shipItems: PendingItem[] = orderItems
      .filter(i => !i.is_sample && !i.is_exchange && (i.shipped_qty ?? 0) > 0)
      .map(i => {
        const productName = i.product_variants?.products?.name ?? "(상품)";
        const opt = [i.product_variants?.color, i.product_variants?.size].filter(Boolean).join("/");
        const qty = i.shipped_qty;
        return {
          name:           productName,
          qty,
          unitPrice:      Number(i.unit_price),
          amount:         qty * Number(i.unit_price),
          option:         opt || undefined,
          registeredDate: formatKstDateOnly(order.created_at as string),
        };
      });
    const pendingData: PendingData = {
      ...businessInfo,
      title:        "발송내역",
      stampLabel:   "발송",
      customerName,
      documentNo:   isReprint ? `${order.order_number} (재발행)` : order.order_number,
      documentDate: docDate,
      items:        shipItems,
      totalCount:   shipItems.length,
      totalQty:     shipItems.reduce((s, it) => s + it.qty, 0),
      totalAmount:  shipItems.reduce((s, it) => s + it.amount, 0),
      productExtras,
      options:      overrides.pending as FormOptions | undefined,
    };
    doc = buildPendingDoc(pendingData);
  } else if (isSampleOnly) {
    // 샘플 전표 — 보류/미송 unshipped 행 제외 (매트릭스: 보류=0).
    // 처리된 샘플 (shipped/ordered) 만 영수증에 표시.
    const sampleItems = orderItems
      .filter(i => !((i.process_type === "hold" || i.process_type === "backorder") && i.status === "unshipped"))
      .map(i => {
        const productName = i.product_variants?.products?.name ?? "(상품)";
        const opt = [i.product_variants?.color, i.product_variants?.size].filter(Boolean).join(" ");
        const qty = i.quantity;
        return {
          name:      productName,
          qty,
          unitPrice: Number(i.unit_price),
          amount:    qty * Number(i.unit_price),
          option:    opt || undefined,
        };
      }).filter(it => it.qty > 0);

    const sampleTotalAmount = sampleItems.reduce((s, it) => s + it.amount, 0);
    const sampleTotalQty    = sampleItems.reduce((s, it) => s + it.qty, 0);

    const sampleData: SampleData = {
      ...businessInfo,
      stampLabel:   "샘플",
      customerName,
      documentNo:   isReprint ? `${order.order_number} (재발행)` : order.order_number,
      documentDate: docDate,
      shipDate,
      items:        sampleItems,
      productExtras,
      totalCount:   sampleItems.length,
      totalQty:     sampleTotalQty,
      totalAmount:  sampleTotalAmount,
      // derived 주문의 자동 memo ("보류 출고 (원본: ...)" 등) 는 양식에 표시 X — 영수증과 동일.
      memo:         derivedFromId ? null : ((order.memo as string | null) ?? null),
      options:      overrides.sample as FormOptions | undefined,
    };
    doc = buildSampleDoc(sampleData);
  } else {
    // 영수증 본문 — 박제 정공법 (163~169) 완료. 박제값 그대로 사용.
    const pmKey = (order.receipt_payment_method as "cash"|"transfer"|"credit"|null)
                ?? (order.payment_method as "cash"|"transfer"|"credit"|null)
                ?? "cash";

    // 박제된 잔액박스 4종. 박제 없으면 undefined → 외상잔액 폴백 라인 사용.
    const balanceSnapshot =
      order.receipt_prev_balance !== null && order.receipt_prev_balance !== undefined
        ? {
            prevBalance:   Number(order.receipt_prev_balance),
            dayTotal:      Number(order.receipt_day_total ?? 0),
            paymentMethod: (order.receipt_payment_method as "cash"|"transfer"|"credit") ?? pmKey,
            paymentAmount: Number(order.receipt_payment_amount ?? 0),
            postBalance:   Number(order.receipt_post_balance ?? 0),
          }
        : undefined;

    const receiptData: ReceiptData = {
      ...businessInfo,
      orderNumber:    order.order_number,
      orderDate:      docDate,
      shipDate,
      customerName,
      paymentMethod:  METHOD_LABELS[pmKey] ?? "—",
      paymentMethodKey: pmKey,
      mode:           receiptMode,
      unshippedFromOriginal,
      items,
      productExtras,
      supply, vat, total,
      vatInPayment,
      outstanding: Number(order.outstanding_amount ?? 0),
      memo: derivedFromId ? null : ((order.memo as string | null) ?? null),
      receiptNo:      (order.receipt_no as string | null) ?? null,
      sessionSeq,
      isReprint,
      balanceSnapshot,
      options: overrides.receipt as FormOptions | undefined,
    };
    doc = buildReceiptDoc(receiptData);
  }

  const bytes = toEscPos(doc);
  const base64 = Buffer.from(bytes).toString("base64");

  // 출력 카운트 증가 (양식 무관 재발행 추적)
  await supabaseAdmin
    .from("orders")
    .update({
      receipt_print_count: printCount + 1,
      receipt_last_printed_at: new Date().toISOString(),
    })
    .eq("id", orderId);

  return NextResponse.json({ bytes: base64, doc });
}

// ── productExtras 계산 — 옵션/혼용율 푸터 ──────────────────────────
// 호출자가 사전 필터링 (샘플/교환 분기) 한 라인을 넘긴다.
function computeProductExtras(orderItems: Array<{
  product_variants: { color: string | null; size: string | null;
                      products: { name: string; material_composition: Record<string, number> | null } | null } | null;
}>): ProductExtra[] {
  const map = new Map<string, ProductExtra>();
  for (const i of orderItems) {
    const p = i.product_variants?.products;
    if (!p) continue;
    const v = i.product_variants;
    const key = p.name;
    let pe = map.get(key);
    if (!pe) {
      pe = { productName: p.name, colors: [], sizes: [], material: formatMaterial(p.material_composition) };
      map.set(key, pe);
    }
    if (v?.color && !pe.colors.includes(v.color)) pe.colors.push(v.color);
    if (v?.size  && !pe.sizes.includes(v.size))   pe.sizes.push(v.size);
  }
  return Array.from(map.values());
}

function formatMaterial(comp: Record<string, number> | null | undefined): string | undefined {
  if (!comp) return undefined;
  const parts = Object.entries(comp).map(([k, v]) => `${k}${v}`);
  return parts.length > 0 ? parts.join(" ") : undefined;
}

