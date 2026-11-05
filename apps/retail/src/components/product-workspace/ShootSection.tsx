"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { supabase } from "@/lib/supabase";
import { styles } from "@/common/styles";
import type { Variant } from "@/lib/samplesUtils";
import type { Model } from "@/components/ModelsSection";

// MD기능 [촬영] — 197 기준 1상품:N촬영.
//   - 상단: 입력 폼 (모델 select / 착용옵션 칩). 날짜·코디·메모는 잘 안 써서 접어 둠.
//   - 하단: 이력 listing (촬영 row 들)
//   - 모델 = models(196) 활성만 dropdown
//   - 코디 = 검색 box 2개 (내 상품명 / 공급상품명) 양방향. 전체 상품 목록이 커서 펼칠 때만 불러옴.
//   - 박제: product_shoots 테이블 (197)

type Coord = { product_id: string; variant_id: string };

type Shoot = {
  id: string;
  product_id: string;
  model_id: string | null;
  worn_variant_id: string | null;
  shoot_date: string | null;
  coordinates: Coord[];
  memo: string | null;
  created_at: string;
};

type ProductLite = {
  id: string;
  consumer_name: string | null;
  wholesale_name: string | null;
  variants: Pick<Variant, "id" | "color" | "size" | "option3" | "consumer_label_color" | "consumer_label_size" | "consumer_label_option3">[];
};

type Props = {
  tenantId: string;
  productId: string;
  ownVariants: Variant[];
  // 다음 상품으로 넘어가도 같은 모델이 선택돼 있게 작업 창이 들고 있음
  initialModelId: string;
  onModelChange: (modelId: string) => void;
  autoFocus: boolean;
  onSaved: (productId: string) => void;
};

// 판매(소매) 옵션명 우선 — OptionChipCell 에서 rename 한 consumer_label_* 를 그대로 반영.
// 라벨 미지정(rename 전) variant 는 도매 원본으로 fallback.
function variantLabel(v: {
  color?: string|null; size?: string|null; option3?: string|null;
  consumer_label_color?: string|null; consumer_label_size?: string|null; consumer_label_option3?: string|null;
}): string {
  return [
    v.consumer_label_color || v.color,
    v.consumer_label_size || v.size,
    v.consumer_label_option3 || v.option3,
  ].filter(Boolean).join(" / ") || "기본";
}

export default function ShootSection({
  tenantId, productId, ownVariants, initialModelId, onModelChange, autoFocus, onSaved,
}: Props) {
  const [loading, setLoading] = useState(true);
  const [models, setModels] = useState<Model[]>([]);
  const [otherProducts, setOtherProducts] = useState<ProductLite[]>([]);
  const [shoots, setShoots] = useState<Shoot[]>([]);

  // 입력 폼 state (등록 또는 수정 중인 row)
  const [editingId, setEditingId] = useState<string | null>(null);
  const [modelId, setModelId] = useState<string>(initialModelId);
  const [wornVariantId, setWornVariantId] = useState<string>("");
  const [shootDate, setShootDate] = useState<string>("");
  const [coords, setCoords] = useState<Coord[]>([]);
  const [memo, setMemo] = useState("");
  const [moreOpen, setMoreOpen] = useState(false);

  // 양방향 검색 state
  const [searchOwn, setSearchOwn] = useState("");
  const [searchSupplier, setSearchSupplier] = useState("");

  const [saving, setSaving] = useState(false);
  const modelRef = useRef<HTMLSelectElement>(null);

  const fetchShoots = useCallback(async () => {
    const { data } = await supabase.from("product_shoots").select("*")
      .eq("product_id", productId).order("created_at", { ascending: false });
    setShoots((data ?? []) as Shoot[]);
  }, [productId]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [{ data: mods }, { data: hist }] = await Promise.all([
        supabase.from("models").select("*").eq("tenant_id", tenantId)
          .eq("is_active", true).order("name"),
        supabase.from("product_shoots").select("*")
          .eq("product_id", productId).order("created_at", { ascending: false }),
      ]);
      if (cancelled) return;
      const activeModels = (mods ?? []) as Model[];
      setModels(activeModels);
      setShoots((hist ?? []) as Shoot[]);
      // 이어받은 모델이 비활성이 됐으면 비움 — 목록에 없는 값이 그대로 저장되지 않게
      setModelId(prev => activeModels.some(m => m.id === prev) ? prev : "");
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [tenantId, productId]);

  useEffect(() => {
    if (!moreOpen) return;
    let cancelled = false;
    (async () => {
      const { data: prods } = await supabase.from("products")
        .select("id, consumer_name, wholesale_name, product_variants(id, color, size, option3, consumer_label_color, consumer_label_size, consumer_label_option3)")
        .eq("tenant_id", tenantId).neq("id", productId)
        .order("created_at", { ascending: false });
      if (cancelled) return;
      setOtherProducts(((prods ?? []) as Array<{
        id: string; consumer_name: string | null; wholesale_name: string | null;
        product_variants: ProductLite["variants"];
      }>).map(p => ({
        id: p.id,
        consumer_name: p.consumer_name,
        wholesale_name: p.wholesale_name,
        variants: p.product_variants ?? [],
      })));
    })();
    return () => { cancelled = true; };
  }, [moreOpen, tenantId, productId]);

  useEffect(() => {
    if (!loading && autoFocus) modelRef.current?.focus();
  }, [loading, autoFocus]);

  function changeModel(id: string) {
    setModelId(id);
    onModelChange(id);
  }

  function resetForm() {
    setEditingId(null);
    changeModel("");
    setWornVariantId("");
    setShootDate("");
    setCoords([]);
    setMemo("");
    setSearchOwn("");
    setSearchSupplier("");
  }

  // 등록 성공 후 — 모델은 남겨둠. 같은 모델이 옵션 여러 개 입고 연달아 촬영하는 경우가 흔해서,
  // 매번 모델을 다시 골라야 하면 깜빡하고 안 고른 채 등록해 model_id가 null로 박히는 사고가 남.
  function resetFormAfterSave() {
    setEditingId(null);
    setWornVariantId("");
    setShootDate("");
    setCoords([]);
    setMemo("");
    setSearchOwn("");
    setSearchSupplier("");
  }

  function loadIntoForm(s: Shoot) {
    setEditingId(s.id);
    setModelId(s.model_id ?? "");
    setWornVariantId(s.worn_variant_id ?? "");
    setShootDate(s.shoot_date ?? "");
    setCoords(s.coordinates ?? []);
    setMemo(s.memo ?? "");
    if (s.shoot_date || s.memo || s.coordinates?.length) setMoreOpen(true);
  }

  async function handleSubmit() {
    setSaving(true);
    const payload = {
      product_id: productId,
      model_id: modelId || null,
      worn_variant_id: wornVariantId || null,
      shoot_date: shootDate || null,
      coordinates: coords,
      memo: memo.trim() || null,
    };
    const { error } = editingId
      ? await supabase.from("product_shoots").update(payload).eq("id", editingId)
      : await supabase.from("product_shoots").insert(payload);
    setSaving(false);
    if (error) { alert(`촬영 저장 실패: ${error.message}`); return; }
    resetFormAfterSave();
    await fetchShoots();
    onSaved(productId);
  }

  async function handleDelete(id: string) {
    if (!confirm("이 촬영 이력을 삭제할까요?")) return;
    const { error } = await supabase.from("product_shoots").delete().eq("id", id);
    if (error) { alert(`촬영 삭제 실패: ${error.message}`); return; }
    if (editingId === id) resetForm();
    await fetchShoots();
    onSaved(productId);
  }

  function addCoord(pid: string, vid: string) {
    if (coords.some(c => c.product_id === pid && c.variant_id === vid)) return;
    setCoords([...coords, { product_id: pid, variant_id: vid }]);
  }
  function removeCoord(idx: number) {
    setCoords(coords.filter((_, i) => i !== idx));
  }

  function findProduct(pid: string) { return otherProducts.find(p => p.id === pid); }
  function findVariant(pid: string, vid: string) {
    return findProduct(pid)?.variants.find(v => v.id === vid);
  }
  function findModel(mid: string | null) {
    return mid ? models.find(m => m.id === mid) : null;
  }
  function ownVariantById(vid: string | null) {
    return vid ? ownVariants.find(v => v.id === vid) : null;
  }

  // 양방향 검색 결과 (이름 기준)
  const ownResults = searchOwn.trim()
    ? otherProducts.filter(p => p.consumer_name?.toLowerCase().includes(searchOwn.toLowerCase())).slice(0, 10)
    : [];
  const supplierResults = searchSupplier.trim()
    ? otherProducts.filter(p => p.wholesale_name?.toLowerCase().includes(searchSupplier.toLowerCase())).slice(0, 10)
    : [];

  return (
    <section className="space-y-3 pt-5 border-t border-gray-200">
      <div className="flex items-center gap-2">
        <h4 className="text-sm font-bold text-black">촬영</h4>
        {editingId && (
          <>
            <span className="text-[11px] text-amber-700">수정 중</span>
            <button type="button" onClick={resetForm}
              className="text-[11px] text-gray-500 hover:text-black underline">
              ← 새로 등록
            </button>
          </>
        )}
      </div>

      {models.length === 0 && !loading && (
        <p className="text-[11px] text-amber-700 bg-amber-50 border border-amber-200 rounded px-2 py-1">
          활성 모델 없음 — 내정보 &gt; 모델 관리에서 추가하세요
        </p>
      )}

      {loading ? (
        <p className="text-xs text-gray-400 text-center py-6">불러오는 중...</p>
      ) : (
        <>
          <div>
            <label htmlFor={`shoot-model-${productId}`} className={styles.modalLabel}>모델</label>
            <select ref={modelRef} id={`shoot-model-${productId}`} value={modelId}
              onChange={e => changeModel(e.target.value)}
              className={styles.modalInput}>
              <option value="">— 선택 안 함 —</option>
              {models.map(m => (
                <option key={m.id} value={m.id}>
                  {m.name}
                  {m.height && ` · ${m.height}cm`}
                  {m.weight && ` · ${m.weight}kg`}
                  {m.top_size && ` · 상의 ${m.top_size}`}
                  {m.bottom_size && ` · 하의 ${m.bottom_size}`}
                  {m.shoe_size && ` · 신발 ${m.shoe_size}`}
                  {m.body_type && ` · ${m.body_type}`}
                </option>
              ))}
            </select>
          </div>

          {/* 착용 옵션 칩 */}
          <div>
            <p className={styles.modalLabel}>착용 옵션</p>
            {ownVariants.length === 0 ? (
              <p className="text-xs text-gray-400">등록된 옵션이 없습니다.</p>
            ) : (
              <div className="flex flex-wrap gap-1">
                <button type="button" onClick={() => setWornVariantId("")} aria-pressed={wornVariantId === ""}
                  className={`px-2 py-1 text-xs rounded border ${
                    wornVariantId === ""
                      ? "border-black bg-black text-white"
                      : "border-gray-300 text-gray-600 hover:bg-gray-50"
                  }`}>
                  없음
                </button>
                {ownVariants.map(v => v.id && (
                  <button key={v.id} type="button" onClick={() => setWornVariantId(v.id!)} aria-pressed={wornVariantId === v.id}
                    className={`px-2 py-1 text-xs rounded border ${
                      wornVariantId === v.id
                        ? "border-black bg-black text-white"
                        : "border-gray-300 text-gray-700 hover:bg-gray-50"
                    }`}>
                    {variantLabel(v)}
                  </button>
                ))}
              </div>
            )}
          </div>

          <button type="button" onClick={() => setMoreOpen(o => !o)} aria-expanded={moreOpen}
            className="text-xs text-gray-500 hover:text-black">
            날짜·코디·메모 {moreOpen ? "▾" : "▸"}
          </button>

          {moreOpen && (
            <div className="space-y-3 border border-gray-200 rounded-lg p-3 bg-gray-50/40">
              <div>
                <label htmlFor={`shoot-date-${productId}`} className={styles.modalLabel}>촬영 날짜</label>
                <input id={`shoot-date-${productId}`} type="date" value={shootDate}
                  onChange={e => setShootDate(e.target.value)}
                  className={styles.modalInput} />
              </div>

              {/* 코디 양방향 검색 */}
              <div>
                <p className={styles.modalLabel}>코디 아이템 <span className="text-gray-400">(다른 상품 + 옵션)</span></p>
                <div className="space-y-2">
                  <CoordSearchColumn
                    title="내 상품명"
                    placeholder="상품명 검색"
                    value={searchOwn}
                    onChange={setSearchOwn}
                    results={ownResults}
                    labelFor={p => p.consumer_name || p.wholesale_name || "(이름 없음)"}
                    onPickVariant={addCoord}
                  />
                  <CoordSearchColumn
                    title="공급 상품명"
                    placeholder="공급 상품명 검색"
                    value={searchSupplier}
                    onChange={setSearchSupplier}
                    results={supplierResults}
                    labelFor={p => p.wholesale_name || p.consumer_name || "(이름 없음)"}
                    onPickVariant={addCoord}
                  />
                </div>

                {coords.length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-1">
                    {coords.map((c, idx) => {
                      const p = findProduct(c.product_id);
                      const v = findVariant(c.product_id, c.variant_id);
                      return (
                        <span key={idx} className="inline-flex items-center gap-1 px-2 py-1 text-xs bg-white border border-gray-300 rounded">
                          {p?.consumer_name || p?.wholesale_name || "불러오는 중"}
                          {v && <span className="text-gray-500">· {variantLabel(v)}</span>}
                          <button type="button" onClick={() => removeCoord(idx)} aria-label="코디 삭제"
                            className="text-red-500 hover:text-red-700 ml-0.5">×</button>
                        </span>
                      );
                    })}
                  </div>
                )}
              </div>

              <div>
                <label htmlFor={`shoot-memo-${productId}`} className={styles.modalLabel}>메모</label>
                <input id={`shoot-memo-${productId}`} value={memo} onChange={e => setMemo(e.target.value)}
                  placeholder="장소, 컨셉 등"
                  className={styles.modalInput} />
              </div>
            </div>
          )}

          <button type="button" onClick={handleSubmit} disabled={saving}
            className={`${styles.btnPrimary} w-full`}>
            {saving ? "저장 중..." : editingId ? "수정 저장" : "+ 등록"}
          </button>

          {/* ── 이력 listing ── */}
          <div>
            <p className="text-xs font-bold text-black mb-1.5">
              촬영 이력 <span className="font-normal text-gray-400">({shoots.length}건)</span>
            </p>
            {shoots.length === 0 ? (
              <p className="text-xs text-gray-400 text-center py-4 border border-dashed border-gray-200 rounded">
                아직 촬영 이력이 없습니다.
              </p>
            ) : (
              <ul className="divide-y divide-gray-100 border border-gray-200 rounded">
                {shoots.map(s => {
                  const m = findModel(s.model_id);
                  const wv = ownVariantById(s.worn_variant_id);
                  const extra = [
                    s.shoot_date,
                    s.coordinates.length > 0 ? `코디 ${s.coordinates.length}개` : "",
                    s.memo ?? "",
                  ].filter(Boolean).join(" · ");
                  return (
                    <li key={s.id} className={`px-3 py-2 ${editingId === s.id ? "bg-amber-50" : "hover:bg-gray-50"}`}>
                      <div className="flex items-center gap-2 text-xs">
                        <span className="font-medium text-black shrink-0">
                          {m?.name ?? <span className="text-gray-400">모델 미지정</span>}
                        </span>
                        <span className="text-gray-700 flex-1 min-w-0 truncate">
                          {wv ? variantLabel(wv) : <span className="text-gray-400">착용 미지정</span>}
                        </span>
                        <button type="button" onClick={() => loadIntoForm(s)}
                          className="text-primary hover:underline shrink-0">수정</button>
                        <button type="button" onClick={() => handleDelete(s.id)}
                          className="text-red-500 hover:underline shrink-0">삭제</button>
                      </div>
                      {extra && <p className="mt-0.5 text-[11px] text-gray-500 truncate">{extra}</p>}
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </>
      )}
    </section>
  );
}

// ──────────────────────────────────────────────────
// 코디 검색 컬럼 — 입력 + 결과 list + 각 결과의 옵션 칩
// ──────────────────────────────────────────────────
function CoordSearchColumn({
  title, placeholder, value, onChange, results, labelFor, onPickVariant,
}: {
  title: string;
  placeholder: string;
  value: string;
  onChange: (v: string) => void;
  results: ProductLite[];
  labelFor: (p: ProductLite) => string;
  onPickVariant: (productId: string, variantId: string) => void;
}) {
  return (
    <div className="border border-gray-200 rounded p-2 bg-white space-y-2">
      <div className="text-[11px] font-medium text-gray-500">{title}</div>
      <input value={value} onChange={e => onChange(e.target.value)}
        placeholder={placeholder}
        aria-label={title}
        className={styles.modalInput} />
      {value.trim() && (
        results.length === 0 ? (
          <p className="text-[11px] text-gray-400 text-center py-2">검색 결과 없음</p>
        ) : (
          <ul className="max-h-40 overflow-y-auto space-y-1">
            {results.map(p => (
              <li key={p.id} className="border border-gray-100 rounded p-1.5">
                <div className="text-xs text-black mb-1 truncate">{labelFor(p)}</div>
                <div className="flex flex-wrap gap-1">
                  {p.variants.length === 0 ? (
                    <span className="text-[11px] text-gray-400">옵션 없음</span>
                  ) : p.variants.map(v => v.id && (
                    <button key={v.id} type="button"
                      onClick={() => onPickVariant(p.id, v.id!)}
                      className="px-1.5 py-0.5 text-[11px] border border-gray-300 rounded hover:bg-gray-100">
                      {variantLabel(v)}
                    </button>
                  ))}
                </div>
              </li>
            ))}
          </ul>
        )
      )}
    </div>
  );
}
