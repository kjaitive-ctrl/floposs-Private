"use client";

import { useEffect, useMemo, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { styles } from "@/common/styles";
import { supabase } from "@/lib/supabase";
import { useTenant } from "@/lib/TenantContext";
import ProductGrid from "@/components/order/ProductGrid";
import { loadSupplierBrief, loadSupplierProducts, type MySupplier } from "@/lib/retailSuppliers";
import type { PortalProduct } from "@/lib/orderPortal";

// 거래처별 "내 상품" 발주 (안건3 C3). param = retail_supplier_id.
// 옛: wholesale tenant 의 상품을 API(cross-tenant)로 load. 새: retail_supplier_id 태깅된 내 상품 browser-direct.
// submit 은 C4 (orders 전자노트) — 지금은 stub. [[project_retail_slot_order_portal_v2]]
export default function SupplierOrderPage() {
  const params = useParams<{ supplierId: string }>();
  const supplierId = params.supplierId;
  const { tenant } = useTenant();

  const [supplier, setSupplier] = useState<MySupplier | null>(null);
  const [products, setProducts] = useState<PortalProduct[]>([]);
  const [qty, setQty] = useState<Map<string, number>>(new Map());
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [sentMsg, setSentMsg] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  // 도매에 공유할 slot 고유 URL (영구 고정, 날짜 무관) 복사
  async function copyShareLink() {
    if (!supplier?.public_code) return;
    const url = `${window.location.origin}/s/${supplier.public_code}`;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      window.prompt("이 링크를 복사해 도매에게 공유하세요:", url);
    }
  }

  useEffect(() => {
    if (!tenant?.id || !supplierId) return;
    let cancelled = false;
    (async () => {
      setLoading(true);
      const [brief, prods] = await Promise.all([
        loadSupplierBrief(tenant.id, supplierId),
        loadSupplierProducts(tenant.id, supplierId),
      ]);
      if (cancelled) return;
      setSupplier(brief);
      setProducts(prods);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [tenant?.id, supplierId]);

  const totalQty = useMemo(() => Array.from(qty.values()).reduce((a, b) => a + b, 0), [qty]);
  const totalAmount = useMemo(() => {
    let sum = 0;
    for (const p of products) for (const v of p.variants) {
      const q = qty.get(v.variant_id) ?? 0;
      if (q > 0) sum += q * (v.unit_price ?? 0);
    }
    return sum;
  }, [products, qty]);

  // 전송 = order_notes + order_note_items 박제 (browser-direct). dev 면 is_test=true 자동격리.
  async function handleSubmit() {
    if (!tenant?.id || !supplier || submitting) return;

    const items: Record<string, unknown>[] = [];
    for (const p of products) {
      for (const v of p.variants) {
        const q = qty.get(v.variant_id) ?? 0;
        if (q <= 0) continue;
        items.push({
          retail_product_id: p.product_id,
          retail_variant_id: v.variant_id,
          supplier_product_name: p.product_name,
          consumer_product_name: p.consumer_name ?? null,
          supplier_option_label: [v.color, v.size, v.option3].filter(Boolean).join(" / ") || null,
          consumer_option_label: [v.consumer_color, v.consumer_size, v.consumer_option3].filter(Boolean).join(" / ") || null,
          variant_barcode: v.barcode ?? null,
          quantity: q,
          unit_price: v.unit_price ?? 0,
        });
      }
    }
    if (items.length === 0) { alert("주문할 수량을 입력해주세요."); return; }

    setSubmitting(true);
    setSentMsg(null);
    const isTest = process.env.NODE_ENV !== "production";
    const sentQty = totalQty;

    // 계약한 물류회사(삼촌) → 픽업 자동 배정. 미계약이면 null (배정 없이 노트만). [[project_logi_axis]]
    const { data: meTenant } = await supabase
      .from("tenants")
      .select("default_logi_tenant_id")
      .eq("id", tenant.id)
      .maybeSingle();

    // 1) 노트 (거래처 1전송, slot 주소)
    const { data: note, error: noteErr } = await supabase
      .from("order_notes")
      .insert({
        sender_retail_tenant_id: tenant.id,
        sender_retail_supplier_id: supplierId,
        recipient_slot_id: supplier.slot_id,
        logi_tenant_id: (meTenant as { default_logi_tenant_id: string | null } | null)?.default_logi_tenant_id ?? null,
        is_test: isTest,
      })
      .select("id")
      .single();
    if (noteErr || !note) {
      setSubmitting(false);
      alert("전송 실패: " + (noteErr?.message ?? "알 수 없는 오류"));
      return;
    }

    // 2) 라인 스냅샷 박제
    const { error: itemsErr } = await supabase
      .from("order_note_items")
      .insert(items.map(it => ({ ...it, note_id: note.id })));
    if (itemsErr) {
      await supabase.from("order_notes").delete().eq("id", note.id); // 롤백
      setSubmitting(false);
      alert("전송 실패(items): " + itemsErr.message);
      return;
    }

    setSubmitting(false);
    setQty(new Map());
    setSentMsg(`전송 완료 — ${items.length}건 (${sentQty}개)${isTest ? " · 테스트" : ""}`);
  }

  return (
    <>
      <main className={styles.main}>
        <div className="flex items-center gap-3 mb-4">
          <Link href="/order/browse" className="text-xs text-gray-500 hover:text-black">
            ← 거래처 목록
          </Link>
          {supplier?.public_code && (
            <button
              type="button"
              onClick={copyShareLink}
              className="ml-auto text-xs text-gray-600 hover:text-black border border-gray-200 rounded px-2 py-1"
            >
              {copied ? "✓ 링크 복사됨" : "📤 도매에 공유"}
            </button>
          )}
        </div>

        <h1 className="text-xl font-bold text-black mb-1">
          {supplier?.store_name ?? "…"}
          {supplier?.loc && <span className="text-gray-400 font-normal text-base"> · {supplier.loc}</span>}
        </h1>
        <p className="text-xs text-gray-500 mb-4">
          이 거래처로 등록한 내 상품입니다. 필요한 수량만 입력해서 한 번에 보내세요.
        </p>

        {loading ? (
          <div className="text-xs text-gray-400">상품 불러오는 중…</div>
        ) : products.length === 0 ? (
          <div className="text-sm text-gray-500 bg-gray-50 border border-gray-200 rounded-xl px-4 py-6 text-center leading-relaxed">
            이 거래처로 등록된 상품이 없습니다.
            <br />
            <Link href="/samples" className="text-primary hover:underline font-medium">
              샘플 등록
            </Link>
            에서 이 거래처의 상품을 먼저 추가하세요.
          </div>
        ) : (
          <ProductGrid products={products} value={qty} onChange={setQty} />
        )}

        {products.length > 0 && (
          <div className="sticky bottom-0 mt-4 bg-white border border-gray-200 rounded-xl px-4 py-3 flex items-center gap-3 flex-wrap">
            <div className="text-xs text-gray-500">
              선택 합계 <span className="text-black font-semibold">{totalQty}</span> 개
              {totalAmount > 0 && <> · <span className="text-black font-semibold">{totalAmount.toLocaleString()}</span> 원</>}
            </div>
            {sentMsg && (
              <div className="text-xs text-emerald-700 bg-emerald-50 border border-emerald-200 rounded px-2 py-1">{sentMsg}</div>
            )}
            <button
              type="button"
              onClick={handleSubmit}
              disabled={submitting || totalQty === 0}
              className={`${styles.btnPrimary} ml-auto disabled:opacity-50`}
            >
              {submitting ? "전송 중…" : "주문 전송"}
            </button>
          </div>
        )}
      </main>
    </>
  );
}
