import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { buildPendingDoc } from "@/app/dashboard/_components/receipt/template";
import { toEscPos } from "@/app/dashboard/_components/receipt/toEscPos";
import type { PendingData } from "@/app/dashboard/_components/receipt/types";
import { formatKstDateTime } from "@/lib/format";

// 상품 단위 미발송 명세서 — 그 상품의 옵션(variant)별 미송/보류 잔량 합계.
// 거래처 무관 — 한 상품의 모든 미발송 잔량 일목요연 표.
//
// GET /api/pending/product/[productId]/print
//   - 옵션별로 그루핑 (color/size). 거래처 합계.
//   - 양식: 미발송 명세서 (잔액 박스 X)

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ productId: string }> }
) {
  const { productId } = await params;

  const authHeader = req.headers.get("authorization");
  const token = authHeader?.replace("Bearer ", "");
  if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { data: { user } } = await supabaseAdmin.auth.getUser(token);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const meta = user.app_metadata as { role?: string; tenant_id?: string };
  const tenantId = meta?.tenant_id;
  if (!tenantId) return NextResponse.json({ error: "missing tenant" }, { status: 403 });

  const [{ data: tenant }, { data: product }] = await Promise.all([
    supabaseAdmin.from("tenants")
      .select("company_name, business_number, owner_name, phone, address, biz_address, main_bank_name, main_bank_account, main_bank_holder")
      .eq("id", tenantId).maybeSingle(),
    supabaseAdmin.from("products")
      .select("id, name, product_no").eq("id", productId).eq("tenant_id", tenantId).maybeSingle(),
  ]);
  if (!tenant)  return NextResponse.json({ error: "사업자 정보 누락" }, { status: 404 });
  if (!product) return NextResponse.json({ error: "상품을 찾을 수 없습니다" }, { status: 404 });

  // 그 상품의 모든 variant + 미발송 항목 fetch
  const { data: rawItems } = await supabaseAdmin.from("order_items")
    .select(`
      variant_id, unit_price, remaining_qty, process_type,
      product_variants!inner ( color, size, product_id ),
      orders!inner ( tenant_id )
    `)
    .eq("orders.tenant_id", tenantId)
    .eq("product_variants.product_id", productId)
    .in("process_type", ["backorder", "hold"])
    .eq("status", "unshipped");

  type RawProductItem = {
    variant_id: string; unit_price: number; remaining_qty: number; process_type: string;
    product_variants: { color: string | null; size: string | null; product_id: string } | null;
  };
  const rows = (rawItems ?? []) as unknown as RawProductItem[];

  // 옵션(variant)별 그루핑 — 옵션 키 = color/size
  type Grouped = {
    color: string; size: string; unitPrice: number;
    backorderQty: number; holdQty: number; totalQty: number;
  };
  const map = new Map<string, Grouped>();
  for (const r of rows) {
    if (!r.product_variants) continue;
    const color = r.product_variants.color ?? "-";
    const size  = r.product_variants.size ?? "-";
    const key = `${color}|${size}`;
    const ex = map.get(key);
    const qty = r.remaining_qty ?? 0;
    if (ex) {
      if (r.process_type === "hold") ex.holdQty += qty;
      else ex.backorderQty += qty;
      ex.totalQty += qty;
    } else {
      map.set(key, {
        color, size,
        unitPrice: Number(r.unit_price),
        backorderQty: r.process_type === "hold" ? 0 : qty,
        holdQty:      r.process_type === "hold" ? qty : 0,
        totalQty:     qty,
      });
    }
  }

  // PendingData.items 으로 변환 (옵션별 행 — 미송/보류 합계 표시)
  const items = Array.from(map.values())
    .filter(g => g.totalQty > 0)
    .sort((a, b) => `${a.color}/${a.size}`.localeCompare(`${b.color}/${b.size}`, "ko"))
    .map(g => {
      const subtitle = g.holdQty > 0 && g.backorderQty > 0
        ? `미송 ${g.backorderQty} / 보류 ${g.holdQty}`
        : g.holdQty > 0 ? `보류` : `미송`;
      return {
        name: product.name,
        qty: g.totalQty,
        unitPrice: g.unitPrice,
        amount: g.totalQty * g.unitPrice,
        option: `${g.color}/${g.size}`,
        registeredDate: subtitle,  // 등록일 자리에 미송/보류 분류 표시
      };
    });

  const totalCount  = items.length;
  const totalQty    = items.reduce((s, it) => s + it.qty, 0);
  const totalAmount = items.reduce((s, it) => s + it.amount, 0);

  const data: PendingData = {
    businessName:   tenant.company_name,
    businessNumber: tenant.business_number ?? null,
    ceoName:        tenant.owner_name ?? null,
    phone:          tenant.phone ?? null,
    address:        tenant.biz_address ?? tenant.address ?? null,
    title:          "상품 미발송 현황",
    stampLabel:     "미발송",
    customerName:   product.name,
    documentNo:     product.product_no ? `상품 ${product.product_no}` : null,
    documentDate:   formatKstDateTime(new Date().toISOString()),
    items,
    totalCount,
    totalQty,
    totalAmount,
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

