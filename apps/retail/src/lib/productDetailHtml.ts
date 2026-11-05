// 상세페이지 HTML — 카페24 전송(api/cafe24/push)과 상품 정보 창(ProductInfoModal) 공용.
// 모듈 단위로 만들어 에이블리처럼 "모듈 붙여넣기 → 이미지 업로드"를 반복하는 플랫폼에서도 쓸 수 있게 함.
// 카페24는 buildDetailHtml 이 모듈 + 이미지를 순서대로 합친 결과를 받음. 모듈 추가/문구 변경은 여기 한 곳만.
import { CAUTION_OPTIONS, SEASON_OPTIONS, WASH_OPTIONS, normalizeDetailOptions, type DetailOptions } from "@/lib/detailOptions";

export interface DetailVariant {
  id: string;
  consumer_label_color: string | null;
  consumer_label_size: string | null;
  consumer_label_option3: string | null;
  is_active: boolean | null;
  sort_order: number | null;
}
export interface DetailMeasurement { size: string; measurements: Record<string, string | number> }
export interface DetailModel { name: string | null; height: number | null; weight: number | null }
export interface DetailShoot {
  model_id: string | null;
  worn_variant_id: string | null;
  models: DetailModel | null;
}
export interface DetailProduct {
  consumer_name: string | null;
  wholesale_name: string | null;
  country_of_origin: string | null;
  material_composition: unknown;
  comment_data: string | null;
  detail_options: unknown;
  product_variants: DetailVariant[];
  product_measurements: DetailMeasurement[];
  product_shoots: DetailShoot[];
}

export function uniq(arr: (string | null | undefined)[]): string[] {
  return [...new Set(arr.filter((v): v is string => !!v))];
}

// 중첩 select(product_variants)는 순서 보장 X → uniq 전에 등록 순서(sort_order)로 정렬해야
// 상세 Size 줄/카페24 옵션이 "L | S | M" 처럼 섞이지 않음 (사이즈표 sizeTableRows 와 동일 기준).
export function sortedActiveVariants<V extends DetailVariant>(p: { product_variants: V[] }): V[] {
  return (p.product_variants ?? [])
    .filter(v => v.is_active !== false)
    .sort((a, b) => (a.sort_order ?? Number.MAX_SAFE_INTEGER) - (b.sort_order ?? Number.MAX_SAFE_INTEGER));
}

export function materialText(raw: unknown): string {
  if (!raw) return "";
  if (typeof raw === "string") return raw;
  if (Array.isArray(raw)) return raw.map((r: { fiber?: string; pct?: number }) => `${r.fiber ?? ""} ${r.pct ?? ""}%`).join(", ");
  // 실제 저장 형식 (materialToText 와 동일 규약): { "폴리에스테르": 100, ... }
  if (typeof raw === "object") {
    return Object.entries(raw as Record<string, unknown>).map(([k, v]) => `${k} ${v}%`).join(", ");
  }
  return "";
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

const TD = `style="border:1px solid #e0e0e0;padding:6px 10px;text-align:center;font-size:12px;"`;
const TH = `style="border:1px solid #e0e0e0;padding:6px 10px;text-align:center;font-size:12px;background:#f8f8f8;font-weight:600;"`;

function sizeTableRows(measurements: DetailMeasurement[], fieldKeys: string[], variants: DetailVariant[]): DetailMeasurement[] {
  if (measurements.length === 0 || fieldKeys.length === 0) return [];

  // 사이즈 정렬 = 옵션 등록 순서(product_variants.sort_order) 기준. 알파벳 정렬 시 M이 S보다
  // 앞에 오는 등 실제 등록 순서와 어긋나는 문제가 있었음 — 같은 사이즈를 쓰는 variant 중 가장
  // 앞선 sort_order를 그 사이즈의 순서로 사용.
  const sizeOrder = new Map<string, number>();
  for (const v of variants) {
    if (!v.consumer_label_size) continue;
    const order = v.sort_order ?? Number.MAX_SAFE_INTEGER;
    const prev = sizeOrder.get(v.consumer_label_size);
    if (prev === undefined || order < prev) sizeOrder.set(v.consumer_label_size, order);
  }

  // 값이 하나라도 있는 row만 포함
  return measurements
    .filter(m => fieldKeys.some(k => m.measurements[k] != null && m.measurements[k] !== ""))
    .sort((a, b) => {
      const oa = sizeOrder.get(a.size) ?? Number.MAX_SAFE_INTEGER;
      const ob = sizeOrder.get(b.size) ?? Number.MAX_SAFE_INTEGER;
      return oa !== ob ? oa - ob : a.size.localeCompare(b.size);
    });
}

function buildSizeTable(measurements: DetailMeasurement[], fieldKeys: string[], variants: DetailVariant[]): string {
  const rows = sizeTableRows(measurements, fieldKeys, variants);
  if (rows.length === 0) return "";

  const headers = ["사이즈", ...fieldKeys].map(k => `<th ${TH}>${escapeHtml(k)}</th>`).join("");
  const trs = rows.map(m => {
    const cells = [
      `<td ${TD}><strong>${escapeHtml(m.size)}</strong></td>`,
      ...fieldKeys.map(k => `<td ${TD}>${escapeHtml(String(m.measurements[k] ?? "—"))}</td>`),
    ].join("");
    return `<tr>${cells}</tr>`;
  }).join("");

  return `<table style="width:100%;border-collapse:collapse;margin:16px 0;">\n<thead><tr>${headers}</tr></thead>\n<tbody>${trs}</tbody>\n</table>`;
}

// 사이즈표 값만 탭 구분으로 — 엑셀에 붙여넣기용. 표가 없으면 빈 문자열.
export function buildSizeTsv(p: DetailProduct, fieldKeys: string[]): string {
  const rows = sizeTableRows(p.product_measurements ?? [], fieldKeys, p.product_variants ?? []);
  if (rows.length === 0) return "";
  return [
    ["사이즈", ...fieldKeys].join("\t"),
    ...rows.map(m => [m.size, ...fieldKeys.map(k => String(m.measurements[k] ?? ""))].join("\t")),
  ].join("\n");
}

const INFO_LABEL = `style="display:inline-block;background:#222;color:#fff;font-size:11px;font-weight:700;padding:3px 12px;border-radius:2px;letter-spacing:0.05em;margin-bottom:6px;"`;
const INFO_VAL   = `style="font-size:13px;color:#333;margin:0 0 14px;text-align:center;"`;

function infoRow(label: string, value: string): string {
  return `<div style="text-align:center;margin-bottom:18px;"><span ${INFO_LABEL}>${escapeHtml(label)}</span><p ${INFO_VAL}>${escapeHtml(value)}</p></div>`;
}

// 계절감 막대 — 선택한 칸만 색을 채우고 나머지는 회색. 사이즈표와 같은 인라인 표 방식.
function buildSeasonBar(options: DetailOptions): string {
  if (options.seasons.length === 0) return "";
  const labels = SEASON_OPTIONS.map(s => {
    const on = options.seasons.includes(s.key);
    return `<td style="text-align:center;padding:0 0 6px;font-size:12px;font-weight:${on ? 700 : 400};color:${on ? "#222" : "#aaa"};">${escapeHtml(s.label)}<br /><span style="font-size:10px;font-weight:400;">${escapeHtml(s.en)}</span></td>`;
  }).join("");
  const bars = SEASON_OPTIONS.map(s => {
    const fill = options.seasons.includes(s.key) ? s.background : "background:#EFEFEF;";
    return `<td style="height:14px;padding:0;border-left:2px solid #fff;border-right:2px solid #fff;${fill}"></td>`;
  }).join("");
  const note = options.season_note
    ? `<p style="margin:8px 0 0;font-size:13px;color:#333;text-align:center;">${escapeHtml(options.season_note)}</p>`
    : "";
  return `<div style="text-align:center;margin-bottom:24px;"><span ${INFO_LABEL}>계절감</span><table style="width:100%;max-width:420px;margin:0 auto;border-collapse:collapse;table-layout:fixed;"><tr>${labels}</tr><tr>${bars}</tr></table>${note}</div>`;
}

function buildCautionBlock(options: DetailOptions): string {
  const items = CAUTION_OPTIONS.filter(c => options.cautions.includes(c.key));
  if (items.length === 0) return "";
  const rows = items.map(c => `<p style="margin:0 0 4px;font-size:12px;color:#333;text-align:center;"><strong>${escapeHtml(c.label)}</strong> ${escapeHtml(c.text)}</p>`).join("");
  return `<div style="text-align:center;margin-bottom:18px;"><span ${INFO_LABEL}>주의사항</span>${rows}</div>`;
}

const QUALITY_GUARANTEE_TEXT ="소비자보호에 관한 법률로 규정되어있는 소비자 청약 철회 가능범위에 해당되는 경우";

// 원산지 표기 정규화 — 자유입력값을 괄호 없는 표준 문구로 치환
function formatOrigin(raw: string | null): string {
  const v = (raw ?? "").trim();
  if (!v) return "-";
  if (v.includes("내수")) return "대한민국";
  if (v.includes("중국")) return "중국";
  return "기타국가";
}

function piRow(label: string, value: string, isLast = false): string {
  const borderBottom = isLast ? "border-bottom:1px solid #e5e5e5;" : "";
  const labelStyle = `style="width:120px;padding:8px 12px;border-top:1px solid #e5e5e5;${borderBottom}color:#888;font-size:12px;background:#fafafa;"`;
  const valueStyle = `style="padding:8px 12px;border-top:1px solid #e5e5e5;${borderBottom}color:#333;font-size:12px;"`;
  return `<tr><td ${labelStyle}>${escapeHtml(label)}</td><td ${valueStyle}>${escapeHtml(value)}</td></tr>`;
}

// 멘트: 줄바꿈 유지 (양식을 그대로 둔 메모는 CommentModal 이 빈 값으로 저장)
function buildCommentModule(p: DetailProduct): string {
  if (!p.comment_data?.trim()) return "";
  return `<p style="font-size:14px;color:#333;text-align:center;margin-bottom:72px;white-space:pre-line;">${escapeHtml(p.comment_data.trim())}</p>`;
}

// 상품정보 (Color / Size / 소재) — 사장 결정: 박스 테두리 없이 라벨+텍스트만
function buildProductInfoModule(p: DetailProduct): string {
  const activeVariants = sortedActiveVariants(p);
  const colors   = uniq(activeVariants.map(v => v.consumer_label_color));
  const sizes    = uniq(activeVariants.map(v => v.consumer_label_size));
  const material = materialText(p.material_composition);
  if (colors.length === 0 && sizes.length === 0 && !material) return "";
  const lines = [`<div style="margin-bottom:24px;">`];
  if (colors.length > 0)   lines.push(infoRow("Color",  colors.join(", ")));
  if (sizes.length > 0)    lines.push(infoRow("Size",   sizes.join(" | ")));
  if (material)            lines.push(infoRow("Fabric", material));
  lines.push(`</div>`);
  return lines.join("\n");
}

function buildWashModule(options: DetailOptions): string {
  const washLabels = WASH_OPTIONS.filter(w => options.washes.includes(w.key)).map(w => w.label);
  return washLabels.length > 0 ? infoRow("세탁방법", washLabels.join(", ")) : "";
}

// 착용정보 (촬영 데이터 전체 — 같은 모델이 옵션 여러 개 입고 촬영하는 경우가 흔함 → 모델별로 묶어서 전부 표기)
function buildWearingModule(p: DetailProduct): string {
  const shoots = p.product_shoots ?? [];
  if (shoots.length === 0) return "";
  type ModelGroup = { m: DetailModel | null; wornLines: string[] };
  const groups = new Map<string, ModelGroup>();
  shoots.forEach((shoot, i) => {
    const key = shoot.model_id ?? `__no-model-${i}`;
    const wornVariant = (p.product_variants ?? []).find(v => v.id === shoot.worn_variant_id);
    const wornLine = [wornVariant?.consumer_label_color, wornVariant?.consumer_label_size, wornVariant?.consumer_label_option3]
      .filter(Boolean).join(" / ");
    let group = groups.get(key);
    if (!group) {
      group = { m: shoot.models, wornLines: [] };
      groups.set(key, group);
    }
    if (wornLine) group.wornLines.push(wornLine);
  });

  const blocks = [...groups.values()].map(({ m, wornLines }) => {
    const modelParts: string[] = [];
    if (m?.name)   modelParts.push(m.name);
    if (m?.height) modelParts.push(`${m.height}cm`);
    if (m?.weight) modelParts.push(`${m.weight}kg`);
    if (modelParts.length === 0 && wornLines.length === 0) return "";
    const modelLine = modelParts.length > 0 ? `<p style="margin:6px 0 2px;">모델: ${escapeHtml(modelParts.join(" / "))}</p>` : "";
    const wornLine = wornLines.length > 0 ? `<p style="margin:2px 0;">착용: ${escapeHtml(wornLines.join(", "))}</p>` : "";
    return modelLine + wornLine;
  }).filter(Boolean);
  if (blocks.length === 0) return "";

  return [
    `<div style="margin-bottom:24px;font-size:12px;color:#555;text-align:center;">`,
    `<span ${INFO_LABEL}>착용정보</span>`,
    ...blocks,
    `</div>`,
  ].join("\n");
}

// 사이즈표 + 고정 안내문구
function buildSizeModule(p: DetailProduct, fieldKeys: string[]): string {
  const sizeTable = buildSizeTable(p.product_measurements ?? [], fieldKeys, p.product_variants ?? []);
  if (!sizeTable) return "";
  return sizeTable + "\n" + `<div style="font-size:11px;color:#888;margin-top:4px;line-height:1.6;">
<p style="margin:2px 0;">1. 사이즈는 단면기준으로 측정됩니다.</p>
<p style="margin:2px 0;">2. 사이즈는 측정 방법과 생산시차에 따라 약 1~3cm 정도 오차가 있을 수 있습니다.</p>
<p style="margin:2px 0;">3. 제품색상은 사용자의 모니터의 해상도에 따라 실제 색상과 다소 차이가 있을 수 있습니다.</p>
<p style="margin:2px 0;">4. 조명이나 환경으로 인해 제품 색상이 정확하지 않을 수 있습니다. 디테일컷의 색상이 실제 상품 색상과 가장 비슷합니다.</p>
</div>`;
}

// PRODUCT INFO — 상품명/소재/제조사/원산지/품질보증기준. 제조사 = 테넌트 상호 + "협력업체".
function buildProductNoticeModule(p: DetailProduct, companyName: string): string {
  const piProductName = (p.consumer_name || p.wholesale_name || "").trim() || "상품명 미입력";
  const piMaterial = materialText(p.material_composition) || "-";
  const piManufacturer = companyName ? `${companyName} 협력업체` : "-";
  const piOrigin = formatOrigin(p.country_of_origin);
  return `<div style="margin-top:48px;">
<p style="text-align:center;font-size:13px;font-weight:700;letter-spacing:0.15em;color:#222;margin-bottom:14px;">PRODUCT INFO</p>
<table style="width:100%;border-collapse:collapse;">
${piRow("상품명", piProductName)}
${piRow("소재", piMaterial)}
${piRow("제조사", piManufacturer)}
${piRow("원산지", piOrigin)}
${piRow("품질보증기준", QUALITY_GUARANTEE_TEXT, true)}
</table>
</div>`;
}

export type DetailModuleKey = "comment" | "season" | "info" | "wash" | "caution" | "wearing" | "size" | "notice";

// html 이 빈 문자열이면 아직 입력 안 된 모듈 (상세페이지에 나가지 않음).
export type DetailModule = { key: DetailModuleKey; label: string; html: string };

export type DetailModules = {
  beforeImages: DetailModule[];
  afterImages: DetailModule[];
};

export function buildDetailModules(p: DetailProduct, fieldKeys: string[], companyName: string): DetailModules {
  const options = normalizeDetailOptions(p.detail_options);
  return {
    beforeImages: [
      { key: "comment", label: "멘트", html: buildCommentModule(p) },
      { key: "season", label: "계절감", html: buildSeasonBar(options) },
      { key: "info", label: "색상·사이즈·소재", html: buildProductInfoModule(p) },
      { key: "wash", label: "세탁방법", html: buildWashModule(options) },
      { key: "caution", label: "주의사항", html: buildCautionBlock(options) },
      { key: "wearing", label: "착용정보", html: buildWearingModule(p) },
    ],
    afterImages: [
      { key: "size", label: "사이즈표", html: buildSizeModule(p, fieldKeys) },
      { key: "notice", label: "PRODUCT INFO", html: buildProductNoticeModule(p, companyName) },
    ],
  };
}

export function buildDetailHtml(
  p: DetailProduct,
  imageUrls: string[],  // cafe24 CDN URL. 빈 배열이면 이미지 없는 HTML
  fieldKeys: string[],
  companyName: string,  // tenants.company_name — "제조사" 표기용
): string {
  const { beforeImages, afterImages } = buildDetailModules(p, fieldKeys, companyName);
  const images = imageUrls.map(url =>
    `<p style="margin:0 0 24px;"><img src="${escapeHtml(url)}" style="max-width:100%;height:auto;display:block;margin:0 auto;" alt="" /></p>`);
  return [
    ...beforeImages.map(m => m.html),
    ...images,
    ...afterImages.map(m => m.html),
  ].filter(Boolean).join("\n");
}
