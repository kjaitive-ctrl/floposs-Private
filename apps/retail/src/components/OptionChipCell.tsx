"use client";

import { useState, KeyboardEvent } from "react";
import { supabase } from "@/lib/supabase";
import type { Variant } from "@/lib/samplesUtils";

// /products 옵션 셀의 chip 인터페이스.
// 한 axis(color/size/option3) 별로 distinct 값 = chip 1개.
// 한 chip = 그 axis 값을 공유하는 모든 variant 의 그룹.
// 액션:
//   1. 토글 [✓판매 / ⊘ 판매X / 품절] — variants 의 is_for_sale/sold_out 일괄 UPDATE
//   2. rename — consumer_label_<axis> 일괄 UPDATE
//   3. + 추가 — cartesian 차원에서 새 variant 들 INSERT (한 axis 의 새 값 + 다른 axis 의 기존 값 조합)
//
// 통째 텍스트 수정은 의도적으로 차단. 콤마는 + 입력 박스 안에서만 허용.

type Axis = "color" | "size" | "option3";

interface Props {
  productId: string;
  variants: Variant[];   // 활성(is_active=true) variants 만 전달
  axis: Axis;
  onChanged: () => void; // 부모가 fetchItems 재호출
  readOnly?: boolean;
}

// axis → variant 의 어느 컬럼을 보는지
function axisKey(axis: Axis): keyof Pick<Variant, "color" | "size" | "option3"> {
  return axis;
}
function labelKey(axis: Axis): keyof Pick<Variant, "consumer_label_color" | "consumer_label_size" | "consumer_label_option3"> {
  if (axis === "color")  return "consumer_label_color";
  if (axis === "size")   return "consumer_label_size";
  return "consumer_label_option3";
}

// 한 axis 의 distinct 라벨 추출. consumer_label_* 우선, fallback 으로 원본.
interface ChipGroup {
  rawKey: string;          // axis 의 원본 값 (DB 박제 키, 그룹 식별용)
  label: string;           // 화면 표시 라벨 (consumer_label 우선)
  variantIds: string[];    // 이 그룹에 속한 variant id 들
  is_for_sale: boolean;    // 그룹 대표 (모두 같은 상태 가정. 다르면 일부 토글 표시)
  sold_out: boolean;
}

function buildGroups(variants: Variant[], axis: Axis): ChipGroup[] {
  const map = new Map<string, ChipGroup>();
  const aKey = axisKey(axis);
  const lKey = labelKey(axis);
  // 안정 순서 보장 — variant_code (R-001-01 = 생성 순서) 기준 정렬.
  // UPDATE 후 Postgres 물리 row 순서가 바뀌어도 chip 순서 유지. fallback = id.
  const sorted = [...variants].sort((a, b) => {
    const ac = a.variant_code ?? "";
    const bc = b.variant_code ?? "";
    if (ac && bc) return ac.localeCompare(bc);
    return (a.id ?? "").localeCompare(b.id ?? "");
  });
  for (const v of sorted) {
    const raw = (v[aKey] ?? "") as string;
    if (!raw) continue;
    const lab = ((v[lKey] as string | null | undefined) ?? raw) as string;
    const existing = map.get(raw);
    if (existing) {
      existing.variantIds.push(v.id!);
      // chip = "이 axis 값으로 살 수 있는 variant 가 있나?" 표시.
      // is_for_sale: 하나라도 판매중이면 활성 (OR).
      // sold_out: 모두 품절이어야 chip 품절 표시 (AND).
      // 색상 × 클릭 → 그 색상 variant 만 비활성 → 사이즈 chip 은 다른 색상 살아있으면 유지.
      existing.is_for_sale = existing.is_for_sale || (v.is_for_sale ?? true);
      existing.sold_out    = existing.sold_out    && (v.sold_out    ?? false);
    } else {
      map.set(raw, {
        rawKey: raw,
        label: lab,
        variantIds: [v.id!].filter(Boolean),
        is_for_sale: v.is_for_sale ?? true,
        sold_out: v.sold_out ?? false,
      });
    }
  }
  return Array.from(map.values());
}

// + 추가: 다른 axis 들의 distinct 값 추출 (카르테시안 곱용)
function otherAxisValues(variants: Variant[], axis: Axis): { sizes: string[]; colors: string[]; option3s: string[] } {
  const sizes = new Set<string>(), colors = new Set<string>(), option3s = new Set<string>();
  for (const v of variants) {
    if (v.color)   colors.add(v.color);
    if (v.size)    sizes.add(v.size);
    if (v.option3) option3s.add(v.option3);
  }
  return { sizes: [...sizes], colors: [...colors], option3s: [...option3s] };
}

export default function OptionChipCell({ productId, variants, axis, onChanged, readOnly }: Props) {
  const [adding, setAdding] = useState(false);
  const [addText, setAddText] = useState("");
  const [renamingKey, setRenamingKey] = useState<string | null>(null);
  const [renameText, setRenameText] = useState("");
  const [busy, setBusy] = useState(false);

  const groups = buildGroups(variants, axis);

  // × 버튼 = soft delete (is_active=false). 사장 결정 2026-05-29 (다)
  // 박제 데이터(orders/transactions) 보존 + UI/사이즈 다운로드에서 즉시 사라짐.
  // 복원은 admin/SQL 로 (드문 케이스).
  async function toggleSale(g: ChipGroup) {
    if (readOnly || busy) return;
    if (!confirm(`"${g.label}" 옵션을 삭제하시겠습니까? (재활성은 admin 에서)`)) return;
    setBusy(true);
    await supabase.from("product_variants")
      .update({ is_active: false })
      .in("id", g.variantIds);
    setBusy(false);
    onChanged();
  }

  async function toggleSoldOut(g: ChipGroup) {
    if (readOnly || busy) return;
    setBusy(true);
    const next = !g.sold_out;
    await supabase.from("product_variants")
      .update({ sold_out: next })
      .in("id", g.variantIds);
    setBusy(false);
    onChanged();
  }

  function startRename(g: ChipGroup) {
    if (readOnly) return;
    setRenamingKey(g.rawKey);
    setRenameText(g.label);
  }

  async function commitRename(g: ChipGroup) {
    if (busy) return;
    const text = renameText.trim();
    setRenamingKey(null);
    if (!text || text === g.label) return;
    setBusy(true);
    await supabase.from("product_variants")
      .update({ [labelKey(axis)]: text })
      .in("id", g.variantIds);
    setBusy(false);
    onChanged();
  }

  async function commitAdd() {
    if (busy) return;
    // 입력 syntax: "공급/판매" 짝 (멘탈 모델 = 받은 도매명 → 사장이 팔 이름).
    // "/" 없으면 양쪽 동일 박제 (fallback). 콤마로 여러 쌍 한 번에.
    // 예: "빨강/레드, 파랑/블루, 그레이"
    type Pair = { supplier: string; consumer: string };
    const pairs: Pair[] = addText
      .split(",")
      .map(s => s.trim())
      .filter(Boolean)
      .map(raw => {
        const idx = raw.indexOf("/");
        if (idx < 0) return { supplier: raw, consumer: raw };
        const supplier = raw.slice(0, idx).trim();
        const consumer = raw.slice(idx + 1).trim();
        return { supplier: supplier || consumer, consumer: consumer || supplier };
      })
      .filter(p => p.supplier);
    setAdding(false);
    setAddText("");
    if (pairs.length === 0) return;

    // 기존 supplier 값 중복 제거 (variant 의 axis 박제값 기준)
    const existingRaws = new Set(groups.map(g => g.rawKey));
    const toAdd = pairs.filter(p => !existingRaws.has(p.supplier));
    if (toAdd.length === 0) return;

    setBusy(true);
    // 다른 axis 의 기존 값과 카르테시안 곱 INSERT
    const { colors, sizes, option3s } = otherAxisValues(variants, axis);
    const rows: {
      product_id: string;
      color: string | null; size: string | null; option3: string | null;
      consumer_label_color?: string | null;
      consumer_label_size?: string | null;
      consumer_label_option3?: string | null;
    }[] = [];

    function makeRow(pair: Pair, axisVal: { color: string | null; size: string | null; option3: string | null }) {
      const base = { product_id: productId, ...axisVal };
      if (axis === "color")  return { ...base, consumer_label_color:   pair.consumer };
      if (axis === "size")   return { ...base, consumer_label_size:    pair.consumer };
      return                       { ...base, consumer_label_option3: pair.consumer };
    }

    for (const pair of toAdd) {
      if (axis === "color") {
        if (sizes.length === 0 && option3s.length === 0) {
          rows.push(makeRow(pair, { color: pair.supplier, size: null, option3: null }));
        } else {
          const sArr = sizes.length ? sizes : [null as unknown as string];
          const oArr = option3s.length ? option3s : [null as unknown as string];
          for (const s of sArr) for (const o of oArr) {
            rows.push(makeRow(pair, { color: pair.supplier, size: s || null, option3: o || null }));
          }
        }
      } else if (axis === "size") {
        if (colors.length === 0 && option3s.length === 0) {
          rows.push(makeRow(pair, { color: null, size: pair.supplier, option3: null }));
        } else {
          const cArr = colors.length ? colors : [null as unknown as string];
          const oArr = option3s.length ? option3s : [null as unknown as string];
          for (const c of cArr) for (const o of oArr) {
            rows.push(makeRow(pair, { color: c || null, size: pair.supplier, option3: o || null }));
          }
        }
      } else {
        // option3
        if (colors.length === 0 && sizes.length === 0) {
          rows.push(makeRow(pair, { color: null, size: null, option3: pair.supplier }));
        } else {
          const cArr = colors.length ? colors : [null as unknown as string];
          const sArr = sizes.length ? sizes : [null as unknown as string];
          for (const c of cArr) for (const s of sArr) {
            rows.push(makeRow(pair, { color: c || null, size: s || null, option3: pair.supplier }));
          }
        }
      }
    }

    if (rows.length > 0) {
      const { error } = await supabase.from("product_variants").insert(rows);
      if (error) {
        console.error("variant INSERT 실패:", error);
        alert(`옵션 추가 실패 (이미 같은 도매 옵션이 있을 수 있음): ${error.message}`);
      }
    }
    setBusy(false);
    onChanged();
  }

  function handleRenameKey(e: KeyboardEvent<HTMLInputElement>, g: ChipGroup) {
    if (e.key === "Enter")  { e.preventDefault(); commitRename(g); }
    if (e.key === "Escape") { setRenamingKey(null); }
  }
  function handleAddKey(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter")  { e.preventDefault(); commitAdd(); }
    if (e.key === "Escape") { setAdding(false); setAddText(""); }
  }

  return (
    <div className="flex flex-wrap items-center gap-1 px-1.5 py-1">
      {groups.map(g => {
        const isRenaming = renamingKey === g.rawKey;
        const chipBase = "inline-flex items-center gap-1 px-1.5 py-0.5 text-xs rounded border";
        const chipColor = !g.is_for_sale
          ? "border-gray-300 bg-gray-50 text-gray-400 line-through"
          : g.sold_out
            ? "border-orange-300 bg-orange-50 text-orange-700"
            : "border-gray-400 bg-white text-black";
        return (
          <span key={g.rawKey} className={`${chipBase} ${chipColor}`}>
            {isRenaming ? (
              <input
                autoFocus
                value={renameText}
                onChange={e => setRenameText(e.target.value)}
                onBlur={() => commitRename(g)}
                onKeyDown={e => handleRenameKey(e, g)}
                className="w-16 px-0.5 text-xs bg-white text-black focus:outline-none border-b border-black"
              />
            ) : (
              <button
                type="button"
                onClick={() => startRename(g)}
                disabled={readOnly}
                title="라벨 수정"
                className="hover:underline disabled:cursor-not-allowed"
              >
                {g.label}
              </button>
            )}
            {g.sold_out && <span className="text-[10px]">품절</span>}
            <button
              type="button"
              onClick={() => toggleSoldOut(g)}
              disabled={readOnly || busy}
              title={g.sold_out ? "품절 해제" : "품절 처리"}
              className="text-[10px] hover:text-orange-600 disabled:cursor-not-allowed"
            >
              {g.sold_out ? "↺" : "⊙"}
            </button>
            <button
              type="button"
              onClick={() => toggleSale(g)}
              disabled={readOnly || busy}
              title={g.is_for_sale ? "판매 X" : "판매 ✓"}
              className="text-[10px] hover:text-red-600 disabled:cursor-not-allowed"
            >
              {g.is_for_sale ? "×" : "↺"}
            </button>
          </span>
        );
      })}

      {adding ? (
        <span className="inline-flex items-center gap-1">
          <input
            autoFocus
            value={addText}
            onChange={e => setAddText(e.target.value)}
            onBlur={commitAdd}
            onKeyDown={handleAddKey}
            placeholder="공급명/판매명"
            title="공급(도매)라벨/판매(소비자)라벨 (예: 빨강/레드, 파랑/블루). '/' 없으면 양쪽 동일."
            className="w-32 px-1 py-0.5 text-xs border border-black bg-white text-black focus:outline-none"
          />
        </span>
      ) : (
        !readOnly && (
          <button
            type="button"
            onClick={() => setAdding(true)}
            disabled={busy}
            title="옵션 추가 (콤마로 여러 개 한 번에)"
            className="inline-flex items-center px-1.5 py-0.5 text-xs text-gray-600 border border-dashed border-gray-300 rounded hover:bg-gray-50 disabled:cursor-not-allowed"
          >
            +
          </button>
        )
      )}
    </div>
  );
}
