"use client";

import { useEffect, useState } from "react";
import { useRouter, useParams } from "next/navigation";
import { supabase } from "@/lib/supabase";
import { PAY_LABEL, ITEM_TYPE_LABEL, ITEM_TYPE_COLOR } from "@/lib/constants";
import { krw, formatDate, formatDateTime } from "@/lib/format";
import { displayOrderNumber } from "@/lib/orderNumber";

type OrderItem = {
  id: string;
  variant_id: string;
  quantity: number;
  unit_price: number;
  total_price: number;
  item_type: string;
  status: string;
  product_variants: { color: string | null; size: string | null; products: { name: string } | null } | null;
};

type LinkedOrder = {
  id: string;
  order_number: string;
  created_at: string;
  total_amount: number;
  payment_method: string | null;
  order_items: { quantity: number; unit_price: number; product_variants: { color: string | null; size: string | null; products: { name: string } | null } | null }[];
};

type OrderDetail = {
  id: string;
  order_number: string;
  status: string;
  payment_method: string | null;
  total_amount: number;
  vat_amount: number | null;
  paid_amount: number;
  outstanding_amount: number;
  memo: string | null;
  created_at: string;
  customers: {
    company_name: string;
    contact1_name: string | null;
    contact1_phone: string | null;
    contact1_role: string | null;
    outstanding_balance: number;
    credit_limit: number;
  } | null;
  order_items: OrderItem[];
};

function displayType(item: OrderItem): string {
  const isShipped = item.status === "shipped" || item.status === "delivered";
  // 오더(order)는 출고 시 새 주문에서 매출 확정되므로 ship으로 표시하지 않음
  return isShipped && item.item_type === "backorder" ? "ship" : item.item_type;
}

export default function OrderDetailPage() {
  const router = useRouter();
  const { id } = useParams<{ id: string }>();

  const [order, setOrder] = useState<OrderDetail | null>(null);
  const [linkedOrders, setLinkedOrders] = useState<LinkedOrder[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => { fetchOrder(); fetchLinkedOrders(); }, [id]);

  async function fetchLinkedOrders() {
    const { data } = await supabase
      .from("orders")
      .select(`
        id, order_number, created_at, total_amount, payment_method,
        order_items(quantity, unit_price, product_variants(color, size, products(name)))
      `)
      .eq("source_order_id", id)
      .order("created_at", { ascending: true });
    if (data) setLinkedOrders(data as unknown as LinkedOrder[]);
  }

  async function fetchOrder() {
    setLoading(true);
    const { data, error } = await supabase
      .from("orders")
      .select(`
        id, order_number, status, payment_method,
        total_amount, vat_amount, paid_amount, outstanding_amount, memo, created_at,
        customers(company_name, contact1_name, contact1_phone, contact1_role, outstanding_balance, credit_limit),
        order_items(
          id, variant_id, quantity, unit_price, total_price, item_type, status,
          product_variants(color, size, products(name))
        )
      `)
      .eq("id", id)
      .single();
    if (!error && data) setOrder(data as unknown as OrderDetail);
    setLoading(false);
  }

  if (loading) return <div className="flex items-center justify-center py-20 text-gray-400">불러오는 중...</div>;
  if (!order) return <div className="flex items-center justify-center py-20 text-gray-400">판매 내역을 찾을 수 없습니다.</div>;

  const customer = order.customers;
  const supplyAmount = order.total_amount - (order.vat_amount ?? 0);

  // 실제 출고 기준 분류
  const shippedItems = order.order_items.filter(i =>
    i.item_type === "ship" || (i.item_type === "backorder" && (i.status === "shipped" || i.status === "delivered"))
  );
  const pendingBackItems = order.order_items.filter(i => i.item_type === "backorder" && !["shipped", "delivered"].includes(i.status));
  const pendingOrderItems = order.order_items.filter(i => i.item_type === "order" && !["shipped", "delivered"].includes(i.status));
  const sampleItems = order.order_items.filter(i => i.item_type === "sample");

  // 인쇄용 섹션도 동일 기준
  const printSections = [
    { label: "출고 내역", items: shippedItems },
    { label: "미송 내역", items: pendingBackItems },
    { label: "오더 내역", items: pendingOrderItems },
    { label: "샘플 내역", items: sampleItems },
  ].filter(s => s.items.length > 0);

  return (
    <>
      {/* 화면 UI */}
      <div className="print:hidden max-w-4xl">
        <div className="flex items-center justify-between mb-6">
          <div className="flex items-center gap-3">
            <button onClick={() => router.back()} className="text-gray-400 hover:text-gray-600 text-sm">← 뒤로</button>
            <h2 className="text-2xl font-bold text-gray-900">{displayOrderNumber(order.order_number)}</h2>
          </div>
        </div>

        <div className="space-y-5">
          <div className="grid grid-cols-2 gap-5">
            {/* 거래처 */}
            <div className="bg-white rounded-xl border border-gray-200 p-5">
              <p className="text-xs font-semibold text-gray-400 uppercase mb-3">거래처</p>
              <p className="text-lg font-bold text-gray-900 mb-2">{customer?.company_name || "-"}</p>
              {customer?.contact1_name && (
                <div className="text-sm text-gray-600 space-y-1">
                  <p><span className="text-gray-400 mr-2">{customer.contact1_role || "담당자"}</span>{customer.contact1_name}</p>
                  {customer.contact1_phone && <p className="text-primary">{customer.contact1_phone}</p>}
                </div>
              )}
              <div className="mt-3 pt-3 border-t border-gray-100 flex gap-4 text-sm">
                <div>
                  <p className="text-xs text-gray-400 mb-0.5">미수금</p>
                  <p className={`font-semibold ${(customer?.outstanding_balance ?? 0) > 0 ? "text-red-500" : "text-gray-600"}`}>
                    {krw(customer?.outstanding_balance ?? 0)}
                  </p>
                </div>
                <div>
                  <p className="text-xs text-gray-400 mb-0.5">외상한도</p>
                  <p className="font-semibold text-gray-600">{krw(customer?.credit_limit ?? 0)}</p>
                </div>
              </div>
            </div>

            {/* 판매 정보 */}
            <div className="bg-white rounded-xl border border-gray-200 p-5">
              <p className="text-xs font-semibold text-gray-400 uppercase mb-3">판매 정보</p>
              <div className="space-y-2.5 text-sm">
                <div className="flex justify-between">
                  <span className="text-gray-500">판매일시</span>
                  <span className="font-medium text-gray-800">{formatDateTime(order.created_at)}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-500">결제방식</span>
                  <span className={`font-medium ${order.payment_method === "credit" ? "text-red-500" : "text-gray-800"}`}>
                    {PAY_LABEL[order.payment_method ?? ""] ?? "-"}
                  </span>
                </div>
                {shippedItems.length > 0 && (
                  <div className="flex justify-between">
                    <span className="text-gray-500">출고금액</span>
                    <span className="font-bold text-green-600">{krw(shippedItems.reduce((s, i) => s + i.total_price, 0))}</span>
                  </div>
                )}
                {pendingBackItems.length > 0 && (
                  <div className="flex justify-between">
                    <span className="text-gray-500">미송금액</span>
                    <span className="font-bold text-orange-500">{krw(pendingBackItems.reduce((s, i) => s + i.total_price, 0))}</span>
                  </div>
                )}
                {pendingOrderItems.length > 0 && (
                  <div className="flex justify-between">
                    <span className="text-gray-500">오더금액</span>
                    <span className="font-bold text-purple-600">{krw(pendingOrderItems.reduce((s, i) => s + i.total_price, 0))}</span>
                  </div>
                )}
                {(order.vat_amount ?? 0) > 0 && (
                  <>
                    <div className="flex justify-between text-xs text-gray-400 pt-1">
                      <span>공급가액</span>
                      <span>{krw(supplyAmount)}</span>
                    </div>
                    <div className="flex justify-between text-xs text-gray-400">
                      <span>부가세 (10%)</span>
                      <span>{krw(order.vat_amount!)}</span>
                    </div>
                  </>
                )}
                <div className="flex justify-between border-t border-gray-100 pt-2">
                  <span className="text-gray-500 font-medium">합계</span>
                  <span className="font-bold text-gray-900 text-base">{krw(order.total_amount)}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-500">미수금</span>
                  <span className={`font-semibold ${order.outstanding_amount > 0 ? "text-red-500" : "text-gray-600"}`}>
                    {krw(order.outstanding_amount)}
                  </span>
                </div>
              </div>
              {order.memo && (
                <div className="mt-3 pt-3 border-t border-gray-100">
                  <p className="text-xs text-gray-400 mb-1">메모</p>
                  <p className="text-sm text-gray-600">{order.memo}</p>
                </div>
              )}
            </div>
          </div>

          {/* 판매 항목 */}
          <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
            <div className="px-5 py-3 border-b border-gray-100 bg-gray-50 flex items-center gap-3">
              <p className="text-sm font-medium text-gray-700">판매 항목</p>
              {shippedItems.length > 0 && <span className="text-xs text-green-600 font-medium">출고 {shippedItems.length}건</span>}
              {pendingBackItems.length > 0 && <span className="text-xs text-orange-500 font-medium">미송 {pendingBackItems.length}건</span>}
              {pendingOrderItems.length > 0 && <span className="text-xs text-purple-600 font-medium">오더 {pendingOrderItems.length}건</span>}
              {sampleItems.length > 0 && <span className="text-xs text-pink-500 font-medium">샘플 {sampleItems.length}건</span>}
            </div>
            <table className="w-full text-sm">
              <thead className="bg-gray-50 border-b border-gray-200">
                <tr>
                  <th className="text-left px-5 py-3 text-gray-600 font-medium">상품명</th>
                  <th className="text-center px-4 py-3 text-gray-600 font-medium">색상</th>
                  <th className="text-center px-4 py-3 text-gray-600 font-medium">사이즈</th>
                  <th className="text-center px-4 py-3 text-gray-600 font-medium">구분</th>
                  <th className="text-center px-4 py-3 text-gray-600 font-medium">수량</th>
                  <th className="text-right px-4 py-3 text-gray-600 font-medium">단가</th>
                  <th className="text-right px-5 py-3 text-gray-600 font-medium">금액</th>
                </tr>
              </thead>
              <tbody>
                {order.order_items.map(item => {
                  const v = item.product_variants;
                  const name = (v?.products as { name: string } | null)?.name ?? "-";
                  const dtype = displayType(item);
                  const isPendingActionable = ["backorder", "order"].includes(item.item_type) && !["shipped", "delivered"].includes(item.status);
                  return (
                    <tr key={item.id}
                      className={`border-b border-gray-100 ${
                        item.item_type === "backorder" && isPendingActionable ? "bg-orange-50" :
                        item.item_type === "order" && isPendingActionable ? "bg-purple-50" :
                        item.item_type === "sample" ? "bg-pink-50" : "hover:bg-gray-50"
                      }`}>
                      <td className="px-5 py-3 font-medium text-gray-800">{name}</td>
                      <td className="px-4 py-3 text-center text-gray-600">{v?.color ?? "-"}</td>
                      <td className="px-4 py-3 text-center text-gray-600">{v?.size ?? "-"}</td>
                      <td className="px-4 py-3 text-center">
                        <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${ITEM_TYPE_COLOR[dtype] ?? "bg-gray-100 text-gray-600"}`}>
                          {ITEM_TYPE_LABEL[dtype] ?? dtype}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-center font-medium text-gray-800">{item.quantity}</td>
                      <td className="px-4 py-3 text-right text-gray-600">{krw(item.unit_price)}</td>
                      <td className={`px-5 py-3 text-right font-semibold ${
                        isPendingActionable && item.item_type === "backorder" ? "text-orange-500" :
                        isPendingActionable && item.item_type === "order" ? "text-purple-600" :
                        "text-gray-900"
                      }`}>
                        {krw(item.total_price)}
                      </td>
                    </tr>
                  );
                })}
                <tr className="border-t-2 border-gray-200 bg-gray-50">
                  <td colSpan={6} className="px-5 py-3 text-right font-semibold text-gray-700">합계</td>
                  <td className="px-5 py-3 text-right font-bold text-gray-900 text-base">{krw(order.total_amount)}</td>
                </tr>
              </tbody>
            </table>
          </div>
          {/* 연결된 출고 주문 */}
          {linkedOrders.length > 0 && (
            <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
              <div className="px-5 py-3 border-b border-gray-100 bg-gray-50 flex items-center gap-2">
                <p className="text-sm font-medium text-gray-700">연결된 출고 주문</p>
                <span className="text-xs text-primary font-medium">{linkedOrders.length}건</span>
              </div>
              <table className="w-full text-sm">
                <thead className="bg-gray-50 border-b border-gray-200">
                  <tr>
                    <th className="text-left px-5 py-2.5 text-gray-500 font-medium text-xs">판매번호</th>
                    <th className="text-left px-4 py-2.5 text-gray-500 font-medium text-xs">상품</th>
                    <th className="text-center px-4 py-2.5 text-gray-500 font-medium text-xs">수량</th>
                    <th className="text-right px-4 py-2.5 text-gray-500 font-medium text-xs">금액</th>
                    <th className="text-center px-5 py-2.5 text-gray-500 font-medium text-xs">출고일시</th>
                  </tr>
                </thead>
                <tbody>
                  {linkedOrders.map(lo => {
                    const firstItem = lo.order_items[0];
                    const v = firstItem?.product_variants;
                    const name = (v?.products as { name: string } | null)?.name ?? "-";
                    const extraCount = lo.order_items.length - 1;
                    return (
                      <tr key={lo.id}
                        className="border-b border-gray-100 hover:bg-primary-soft cursor-pointer transition-colors"
                        onClick={() => router.push(`/dashboard/orders-test/${lo.id}`)}>
                        <td className="px-5 py-2.5 font-medium text-primary-hover">{displayOrderNumber(lo.order_number)}</td>
                        <td className="px-4 py-2.5 text-gray-700">
                          {name}
                          {v?.color && <span className="text-gray-400 ml-1">{v.color}</span>}
                          {v?.size && <span className="text-gray-400 ml-1">{v.size}</span>}
                          {extraCount > 0 && <span className="text-gray-400 ml-1">외 {extraCount}건</span>}
                        </td>
                        <td className="px-4 py-2.5 text-center text-gray-700">
                          {lo.order_items.reduce((s, i) => s + i.quantity, 0)}개
                        </td>
                        <td className="px-4 py-2.5 text-right font-medium text-gray-900">{krw(lo.total_amount)}</td>
                        <td className="px-5 py-2.5 text-center text-gray-500 text-xs">{formatDateTime(lo.created_at)}</td>
                      </tr>
                    );
                  })}
                </tbody>
                <tfoot>
                  <tr className="bg-gray-50 border-t-2 border-gray-200">
                    <td colSpan={3} className="px-5 py-2.5 text-right text-xs font-semibold text-gray-600">총 출고금액</td>
                    <td className="px-4 py-2.5 text-right font-bold text-primary-hover">
                      {krw(linkedOrders.reduce((s, o) => s + o.total_amount, 0))}
                    </td>
                    <td />
                  </tr>
                </tfoot>
              </table>
            </div>
          )}
        </div>
      </div>

      {/* 영수증 (인쇄 전용) */}
      <div className="hidden print:block p-6 max-w-sm mx-auto text-sm font-sans">
        <div className="text-center mb-4">
          <h1 className="text-xl font-bold mb-1">거래 명세서</h1>
          <p className="text-gray-500 text-xs">{displayOrderNumber(order.order_number)}</p>
        </div>

        <div className="border-t border-b border-black py-3 mb-4 space-y-1.5">
          <div className="flex justify-between">
            <span className="font-semibold">{customer?.company_name ?? "-"} 귀중</span>
            <span>{formatDate(order.created_at)}</span>
          </div>
          {customer?.contact1_name && (
            <div className="flex justify-between text-gray-600">
              <span>{customer.contact1_role ?? "담당"}: {customer.contact1_name}</span>
              <span>{customer.contact1_phone}</span>
            </div>
          )}
          <div className="flex justify-between">
            <span>결제방식</span>
            <span className="font-medium">{PAY_LABEL[order.payment_method ?? ""] ?? "-"}</span>
          </div>
        </div>

        {printSections.map(section => (
          <div key={section.label}>
            <p className="font-bold mb-1">■ {section.label}</p>
            <table className="w-full mb-3 text-xs">
              <thead>
                <tr className="border-b border-gray-400">
                  <th className="text-left py-1">상품명</th>
                  <th className="text-center py-1">색상</th>
                  <th className="text-center py-1">사이즈</th>
                  <th className="text-center py-1">수량</th>
                  <th className="text-right py-1">금액</th>
                </tr>
              </thead>
              <tbody>
                {section.items.map(item => {
                  const v = item.product_variants;
                  const name = (v?.products as { name: string } | null)?.name ?? "-";
                  return (
                    <tr key={item.id} className="border-b border-gray-200">
                      <td className="py-1">{name}</td>
                      <td className="text-center py-1">{v?.color ?? "-"}</td>
                      <td className="text-center py-1">{v?.size ?? "-"}</td>
                      <td className="text-center py-1">{item.quantity}</td>
                      <td className="text-right py-1">{item.total_price.toLocaleString()}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <div className="flex justify-between text-xs mb-4">
              <span>{section.label} 소계</span>
              <span className="font-bold">{krw(section.items.reduce((s, i) => s + i.total_price, 0))}</span>
            </div>
          </div>
        ))}

        <div className="border-t-2 border-black pt-3 flex justify-between text-base font-bold">
          <span>합 계</span>
          <span>{krw(order.total_amount)}</span>
        </div>
        {order.memo && <p className="mt-3 text-xs text-gray-500">※ {order.memo}</p>}
        <div className="mt-8 text-center text-xs text-gray-400">감사합니다.</div>
      </div>
    </>
  );
}
