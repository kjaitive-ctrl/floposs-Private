import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { buildPendingDoc } from "@/app/dashboard/_components/receipt/template";
import { toEscPos } from "@/app/dashboard/_components/receipt/toEscPos";
import type { PendingData, PendingItem, PendingSection } from "@/app/dashboard/_components/receipt/types";
import { formatKstDateOnly, formatKstDateTime } from "@/lib/format";

// 거래처 단위 미발송(미송/보류) 명세서 출력용 ESC/POS bytes 생성.
//
// GET /api/pending/customer/[customerId]/print?session=today|all&kind=backorder|hold|all
//   - session=today: 현재 영업 세션의 미발송만
//   - session=all:   거래처의 전체 기간 미발송
//   - kind=backorder: 미송만 / kind=hold: 보류만 / kind=all (기본): 둘 다
//
// 응답: { bytes: base64, doc: ReceiptDoc }

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ customerId: string }> }
) {
  const { customerId } = await params;
  const { searchParams } = new URL(req.url);
  const session = (searchParams.get("session") ?? "all") as "today" | "all";
  const kind    = (searchParams.get("kind") ?? "all") as "backorder" | "hold" | "all";

  // 인증
  const authHeader = req.headers.get("authorization");
  const token = authHeader?.replace("Bearer ", "");
  if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { data: { user } } = await supabaseAdmin.auth.getUser(token);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const meta = user.app_metadata as { role?: string; tenant_id?: string };
  const tenantId = meta?.tenant_id;
  if (!tenantId) return NextResponse.json({ error: "missing tenant" }, { status: 403 });

  // tenant 사업자정보 + 거래처 정보 + (선택) 활성 영업세션 조회
  const [{ data: tenant }, { data: customer }, { data: bizSession }] = await Promise.all([
    supabaseAdmin.from("tenants")
      .select("company_name, business_number, owner_name, phone, address, biz_address, main_bank_name, main_bank_account, main_bank_holder")
      .eq("id", tenantId).maybeSingle(),
    supabaseAdmin.from("customers")
      .select("company_name").eq("id", customerId).eq("tenant_id", tenantId).maybeSingle(),
    session === "today"
      ? supabaseAdmin.from("biz_sessions").select("id").eq("tenant_id", tenantId).eq("status", "open").maybeSingle()
      : Promise.resolve({ data: null as { id: string } | null }),
  ]);

  if (!tenant)   return NextResponse.json({ error: "사업자 정보 누락" }, { status: 404 });
  if (!customer) return NextResponse.json({ error: "거래처를 찾을 수 없습니다" }, { status: 404 });
  if (session === "today" && !bizSession) {
    return NextResponse.json({ error: "활성 영업 세션이 없습니다" }, { status: 400 });
  }

  // 미발송 항목 fetch
  const processTypes = kind === "all" ? ["backorder", "hold"] : [kind];
  let q = supabaseAdmin.from("order_items")
    .select(`
      id, quantity, unit_price, remaining_qty, process_type, created_at,
      product_variants ( color, size, products ( name ) ),
      orders!inner ( id, customer_id, tenant_id, biz_session_id, created_at )
    `)
    .eq("orders.tenant_id", tenantId)
    .eq("orders.customer_id", customerId)
    .in("process_type", processTypes)
    .eq("status", "unshipped")
    .order("created_at", { ascending: true });

  if (session === "today" && bizSession) {
    q = q.eq("orders.biz_session_id", bizSession.id);
  }

  const { data: rawItems } = await q;

  type RawPendingItem = {
    quantity: number; unit_price: number; remaining_qty: number;
    process_type: string; created_at: string;
    product_variants: { color: string | null; size: string | null;
                        products: { name: string } | null } | null;
    orders: { created_at: string } | null;
  };

  type MappedItem = PendingItem & { processType: "backorder" | "hold" };
  const mapped: MappedItem[] = ((rawItems ?? []) as unknown as RawPendingItem[]).map(it => {
    const productName = it.product_variants?.products?.name ?? "(상품)";
    const opt = [it.product_variants?.color, it.product_variants?.size].filter(Boolean).join("/");
    const qty = it.remaining_qty ?? 0;
    const orderDate = it.orders?.created_at ?? it.created_at;
    return {
      processType: it.process_type as "backorder" | "hold",
      name: productName,
      qty,
      unitPrice: Number(it.unit_price),
      amount: qty * Number(it.unit_price),
      option: opt || undefined,
      registeredDate: orderDate ? formatKstDateOnly(orderDate) : undefined,
    };
  }).filter(it => it.qty > 0);

  const stripType = ({ processType: _pt, ...rest }: MappedItem): PendingItem => rest;
  const items: PendingItem[] = mapped.map(stripType);

  const totalCount  = items.length;
  const totalQty    = items.reduce((s, it) => s + it.qty, 0);
  const totalAmount = items.reduce((s, it) => s + it.amount, 0);

  // kind=all 이고 미송+보류 둘 다 있을 때만 섹션 분리.
  // 한쪽만 있으면 평면 (sections 미할당).
  let sections: PendingSection[] | undefined;
  if (kind === "all") {
    const back = mapped.filter(m => m.processType === "backorder");
    const hold = mapped.filter(m => m.processType === "hold");
    if (back.length > 0 && hold.length > 0) {
      const buildSec = (label: string, list: MappedItem[]): PendingSection => ({
        label,
        items: list.map(stripType),
        subCount: list.length,
        subQty: list.reduce((s, it) => s + it.qty, 0),
        subAmount: list.reduce((s, it) => s + it.amount, 0),
      });
      sections = [buildSec("미송", back), buildSec("보류", hold)];
    }
  }

  // 양식 (kind 별 헤더/도장 분기)
  const title = kind === "hold" ? "보류 명세서"
              : kind === "backorder" ? "미발송내역"
              : "미발송/보류 내역";
  const stampLabel = kind === "hold" ? "보류"
                   : kind === "backorder" ? "미송"
                   : "미발송";

  const docDate = formatKstDateTime(new Date().toISOString());
  const data: PendingData = {
    businessName:   tenant.company_name,
    businessNumber: tenant.business_number ?? null,
    ceoName:        tenant.owner_name ?? null,
    phone:          tenant.phone ?? null,
    address:        tenant.biz_address ?? tenant.address ?? null,
    title,
    stampLabel,
    customerName:   customer.company_name,
    documentNo:     null,
    documentDate:   docDate,
    items,
    totalCount,
    totalQty,
    totalAmount,
    sections,
    bankInfo: tenant.main_bank_name && tenant.main_bank_account ? {
      name:    tenant.main_bank_name,
      account: tenant.main_bank_account,
      holder:  tenant.main_bank_holder ?? "",
    } : null,
    vatNote: "상기금액은 부가세별도 금액입니다.",
  };

  const doc = buildPendingDoc(data);
  const bytes = toEscPos(doc);
  const base64 = Buffer.from(bytes).toString("base64");
  return NextResponse.json({ bytes: base64, doc });
}

