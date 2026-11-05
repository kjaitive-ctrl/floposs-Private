"use client";

import { useEffect, useRef, useState } from "react";
import { supabase } from "@/lib/supabase";
import { styles } from "@/common/styles";
import { formatComma } from "@/lib/format";
import {
  buildDetailHtml, buildDetailModules, buildSizeTsv,
  type DetailModule, type DetailModuleKey, type DetailProduct,
} from "@/lib/productDetailHtml";

// MD기능 [정보] — 한 상품의 등록 정보를 한 화면에서 보고 복사.
// 왼쪽 = 플랫폼 입력칸에 옮길 값, 오른쪽 = 상세페이지 HTML 모듈 (카페24 전송과 같은 내용).
// 값 수정은 기존 멘트/촬영/SIZE/IMG 창을 그대로 열고, 저장되면 reloadKey 로 다시 읽음.
// 바깥 클릭 닫기 없음 — 다른 탭과 오가며 복사하다가 닫히는 사고 방지.

type EditorKind = "comment" | "shoot" | "size";

const MODULE_EDITOR: Partial<Record<DetailModuleKey, EditorKind>> = {
  comment: "comment",
  season: "comment",
  wash: "comment",
  caution: "comment",
  wearing: "shoot",
  size: "size",
};

const EDITOR_LABEL: Record<EditorKind, string> = { comment: "멘트", shoot: "촬영", size: "SIZE" };

export type ProductInfoFields = {
  consumer_name: string;
  wholesale_name: string;
  supplier: string;
  supplier_loc: string;
  wholesale_price: string;
  wholesale_discount_price: string;
  regular_sale_price: string;
  sale_price: string;
  consumer_price: string;
  margin: string;
  category: string;
  country_of_origin: string;
  material_composition: string;
  colors: string;
  sizes: string;
  option3s: string;
  barcode: string;
};

type Props = {
  tenantId: string;
  productId: string;
  category: string;
  fields: ProductInfoFields;
  reloadKey: number;
  onEdit: (editor: EditorKind) => void;
  onOpenImages: () => void;
  onClose: () => void;
};

type LoadedDetail = {
  product: DetailProduct;
  fieldKeys: string[];
  companyName: string;
  detailImageCount: number;
  thumbnailCount: number;
};

export default function ProductInfoModal({
  tenantId, productId, category, fields, reloadKey, onEdit, onOpenImages, onClose,
}: Props) {
  const [detail, setDetail] = useState<LoadedDetail | null>(null);
  const [loadError, setLoadError] = useState("");
  const [copiedKey, setCopiedKey] = useState("");
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [productRes, tenantRes, templateRes] = await Promise.all([
        supabase.from("products")
          .select(`
            consumer_name, wholesale_name, country_of_origin, material_composition,
            comment_data, detail_options,
            product_variants(id, consumer_label_color, consumer_label_size, consumer_label_option3, is_active, sort_order),
            product_images(image_type),
            product_measurements(size, measurements),
            product_shoots(model_id, worn_variant_id, models(name, height, weight))
          `)
          .eq("id", productId)
          .single(),
        supabase.from("tenants").select("company_name").eq("id", tenantId).single(),
        category
          ? supabase.from("measurement_templates")
              .select("tenant_id, field_keys")
              .eq("category", category)
              .or(`tenant_id.is.null,tenant_id.eq.${tenantId}`)
          : Promise.resolve({ data: [] as { tenant_id: string | null; field_keys: string[] }[] }),
      ]);
      if (cancelled) return;
      if (productRes.error || !productRes.data) {
        setLoadError(productRes.error?.message ?? "상품을 찾을 수 없습니다.");
        return;
      }
      const product = productRes.data as unknown as DetailProduct & { product_images: { image_type: string | null }[] };
      const images = product.product_images ?? [];
      // 같은 카테고리면 이 매장 양식 우선, 없으면 시스템 공통
      const templates = (templateRes.data ?? []) as { tenant_id: string | null; field_keys: string[] }[];
      const template = templates.find(t => t.tenant_id) ?? templates[0];
      setLoadError("");
      setDetail({
        product,
        fieldKeys: template?.field_keys ?? [],
        companyName: (tenantRes.data as { company_name?: string | null } | null)?.company_name?.trim() || "",
        detailImageCount: images.filter(i => i.image_type !== "thumbnail").length,
        thumbnailCount: images.filter(i => i.image_type === "thumbnail").length,
      });
    })();
    return () => { cancelled = true; };
  }, [tenantId, productId, category, reloadKey]);

  useEffect(() => () => {
    if (copiedTimer.current) clearTimeout(copiedTimer.current);
  }, []);

  async function copy(key: string, text: string) {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      alert("복사하지 못했습니다. 브라우저의 클립보드 권한을 확인해 주세요.");
      return;
    }
    setCopiedKey(key);
    if (copiedTimer.current) clearTimeout(copiedTimer.current);
    copiedTimer.current = setTimeout(() => setCopiedKey(""), 1500);
  }

  const modules = detail ? buildDetailModules(detail.product, detail.fieldKeys, detail.companyName) : null;
  const sizeTsv = detail ? buildSizeTsv(detail.product, detail.fieldKeys) : "";

  function fieldRow(label: string, value: string, copyValue = value) {
    const key = `field-${label}`;
    return (
      <button key={key} type="button" disabled={!value}
        onClick={() => copy(key, copyValue)}
        className="w-full flex items-start gap-2 px-2 py-1.5 text-left text-xs rounded hover:bg-gray-100 disabled:hover:bg-transparent group/field">
        <span className="w-20 shrink-0 text-gray-500">{label}</span>
        <span className="flex-1 min-w-0 break-words text-black">{value || <span className="text-gray-300">-</span>}</span>
        {value && (
          <span className={"shrink-0 text-[11px] " + (copiedKey === key ? "text-emerald-700 font-medium" : "text-gray-300 group-hover/field:text-gray-600")}>
            {copiedKey === key ? "복사됨" : "복사"}
          </span>
        )}
      </button>
    );
  }

  function moduleBlock(m: DetailModule) {
    const editor = MODULE_EDITOR[m.key];
    const copied = copiedKey === `module-${m.key}`;
    return (
      <section key={m.key} className="border border-gray-200 rounded">
        <div className="flex items-center gap-2 px-3 py-1.5 bg-gray-50 border-b border-gray-200 rounded-t">
          <span className="text-xs font-bold text-black flex-1">{m.label}</span>
          {editor && (
            <button type="button" onClick={() => onEdit(editor)} className={styles.btnSmallGhost}>
              {EDITOR_LABEL[editor]} 수정
            </button>
          )}
          {m.key === "size" && sizeTsv && (
            <button type="button" onClick={() => copy("size-tsv", sizeTsv)} className={styles.btnSmallGhost}>
              {copiedKey === "size-tsv" ? "복사됨" : "엑셀용 복사"}
            </button>
          )}
          <button type="button" disabled={!m.html} onClick={() => copy(`module-${m.key}`, m.html)}
            className={styles.btnSmall + " disabled:opacity-30 disabled:cursor-not-allowed"}>
            {copied ? "복사됨" : "HTML 복사"}
          </button>
        </div>
        {m.html ? (
          // 모듈 HTML 은 productDetailHtml 에서 입력값을 모두 이스케이프해 만든 것.
          <div className="p-3 overflow-x-auto bg-white" dangerouslySetInnerHTML={{ __html: m.html }} />
        ) : (
          <p className="px-3 py-3 text-xs text-gray-400">입력된 내용 없음</p>
        )}
      </section>
    );
  }

  return (
    <div className={styles.modalOverlay}>
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-6xl max-h-[92vh] flex flex-col">
        <div className="px-6 pt-5 pb-3 border-b border-gray-100 flex items-start justify-between gap-4">
          <div className="min-w-0">
            <h3 className="text-lg font-bold text-black mb-0.5">상품 정보</h3>
            <p className="text-xs text-gray-500 truncate">{fields.consumer_name || fields.wholesale_name}</p>
          </div>
          <button type="button" onClick={onClose} aria-label="닫기"
            className="text-gray-400 hover:text-black text-xl leading-none">×</button>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto md:overflow-hidden flex flex-col md:flex-row">
          {/* 왼쪽: 입력칸에 옮길 값 */}
          <div className="md:w-80 shrink-0 md:overflow-y-auto px-4 py-3 border-b md:border-b-0 md:border-r border-gray-100 space-y-3">
            <div>
              <p className="px-2 mb-1 text-[11px] font-bold text-gray-400">상품</p>
              {fieldRow("상품명", fields.consumer_name)}
              {fieldRow("공급상품명", fields.wholesale_name)}
              {fieldRow("상품코드", fields.barcode)}
              {fieldRow("카테고리", fields.category)}
            </div>
            <div>
              <p className="px-2 mb-1 text-[11px] font-bold text-gray-400">가격</p>
              {fieldRow("상시판매가", formatComma(fields.regular_sale_price), fields.regular_sale_price)}
              {fieldRow("판매가", formatComma(fields.sale_price), fields.sale_price)}
              {fieldRow("소비자가", formatComma(fields.consumer_price), fields.consumer_price)}
              {fieldRow("도매가", formatComma(fields.wholesale_price), fields.wholesale_price)}
              {fieldRow("할인가", formatComma(fields.wholesale_discount_price), fields.wholesale_discount_price)}
              {fieldRow("마진", fields.margin)}
            </div>
            <div>
              <p className="px-2 mb-1 text-[11px] font-bold text-gray-400">공급처</p>
              {fieldRow("공급사", fields.supplier)}
              {fieldRow("위치", fields.supplier_loc)}
            </div>
            <div>
              <p className="px-2 mb-1 text-[11px] font-bold text-gray-400">옵션</p>
              {fieldRow("색상", fields.colors)}
              {fieldRow("사이즈", fields.sizes)}
              {fieldRow("옵션3", fields.option3s)}
            </div>
            <div>
              <p className="px-2 mb-1 text-[11px] font-bold text-gray-400">표시 정보</p>
              {fieldRow("제조국", fields.country_of_origin)}
              {fieldRow("혼용율", fields.material_composition)}
            </div>
          </div>

          {/* 오른쪽: 상세페이지 모듈 (위에서 아래 순서대로 붙여넣기) */}
          <div className="flex-1 min-w-0 md:overflow-y-auto px-4 py-3 space-y-2">
            {loadError ? (
              <p className="text-xs text-red-500 text-center py-6">불러오지 못했습니다: {loadError}</p>
            ) : !detail || !modules ? (
              <p className="text-xs text-gray-400 text-center py-6">불러오는 중...</p>
            ) : (
              <>
                <div className="flex items-center justify-between gap-2 pb-1">
                  <p className="text-xs text-gray-500">상세페이지 모듈 · 위에서부터 순서대로 사용하세요</p>
                  <button type="button"
                    onClick={() => copy("all", buildDetailHtml(detail.product, [], detail.fieldKeys, detail.companyName))}
                    className={styles.btnSmallGhost + " whitespace-nowrap"}>
                    {copiedKey === "all" ? "복사됨" : "전체 복사 (이미지 제외)"}
                  </button>
                </div>
                {modules.beforeImages.map(moduleBlock)}
                <div className="flex items-center gap-2 px-3 py-2 rounded border border-dashed border-gray-400 bg-gray-50">
                  <span className="text-xs font-bold text-black">이미지</span>
                  <span className="text-xs text-gray-600 flex-1">
                    상세 {detail.detailImageCount}장 · 썸네일 {detail.thumbnailCount}장
                  </span>
                  <button type="button" onClick={onOpenImages} className={styles.btnSmall}>이미지 열기</button>
                </div>
                {modules.afterImages.map(moduleBlock)}
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
