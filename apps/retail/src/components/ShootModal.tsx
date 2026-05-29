"use client";

import { useEffect, useState, useCallback } from "react";
import { supabase } from "@/lib/supabase";
import { styles } from "@/common/styles";
import type { Variant } from "@/lib/samplesUtils";
import type { Model } from "./ModelsSection";

// MD기능 [촬영] — 197 기준 1상품:N촬영.
//   - 상단: 가로 입력 폼 (모델 select / 착용옵션 칩 / 날짜 / 코디 양방향 검색 / 메모)
//   - 하단: 세로 이력 listing (촬영 row 들)
//   - 모델 = models(196) 활성만 dropdown
//   - 코디 = 검색 box 2개 (내 상품명 / 공급상품명) 양방향
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
  variants: Pick<Variant, "id" | "color" | "size" | "option3">[];
};

type Props = {
  tenantId: string;
  productId: string;
  productName: string;
  ownVariants: Variant[];
  onClose: () => void;
  onSaved: () => void;
};

function variantLabel(v: { color?: string|null; size?: string|null; option3?: string|null }): string {
  return [v.color, v.size, v.option3].filter(Boolean).join(" / ") || "기본";
}

export default function ShootModal({
  tenantId, productId, productName, ownVariants, onClose, onSaved,
}: Props) {
  const [loading, setLoading] = useState(true);
  const [models, setModels] = useState<Model[]>([]);
  const [otherProducts, setOtherProducts] = useState<ProductLite[]>([]);
  const [shoots, setShoots] = useState<Shoot[]>([]);

  // 입력 폼 state (등록 또는 수정 중인 row)
  const [editingId, setEditingId] = useState<string | null>(null);
  const [modelId, setModelId] = useState<string>("");
  const [wornVariantId, setWornVariantId] = useState<string>("");
  const [shootDate, setShootDate] = useState<string>("");
  const [coords, setCoords] = useState<Coord[]>([]);
  const [memo, setMemo] = useState("");

  // 양방향 검색 state
  const [searchOwn, setSearchOwn] = useState("");
  const [searchSupplier, setSearchSupplier] = useState("");

  const [saving, setSaving] = useState(false);

  const fetchAll = useCallback(async () => {
    setLoading(true);
    const [{ data: mods }, { data: prods }, { data: hist }] = await Promise.all([
      supabase.from("models").select("*").eq("tenant_id", tenantId)
        .eq("is_active", true).order("name"),
      supabase.from("products")
        .select("id, consumer_name, wholesale_name, product_variants(id, color, size, option3)")
        .eq("tenant_id", tenantId).neq("id", productId)
        .order("created_at", { ascending: false }),
      supabase.from("product_shoots").select("*")
        .eq("product_id", productId).order("created_at", { ascending: false }),
    ]);
    setModels((mods ?? []) as Model[]);
    setOtherProducts(((prods ?? []) as Array<{
      id: string; consumer_name: string | null; wholesale_name: string | null;
      product_variants: ProductLite["variants"];
    }>).map(p => ({
      id: p.id,
      consumer_name: p.consumer_name,
      wholesale_name: p.wholesale_name,
      variants: p.product_variants ?? [],
    })));
    setShoots((hist ?? []) as Shoot[]);
    setLoading(false);
  }, [tenantId, productId]);

  useEffect(() => { fetchAll(); }, [fetchAll]);

  function resetForm() {
    setEditingId(null);
    setModelId("");
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
    if (editingId) {
      await supabase.from("product_shoots").update(payload).eq("id", editingId);
    } else {
      await supabase.from("product_shoots").insert(payload);
    }
    setSaving(false);
    resetForm();
    await fetchAll();
    onSaved();
  }

  async function handleDelete(id: string) {
    if (!confirm("이 촬영 이력을 삭제할까요?")) return;
    await supabase.from("product_shoots").delete().eq("id", id);
    if (editingId === id) resetForm();
    await fetchAll();
    onSaved();
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
    <div className={styles.modalOverlay} onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-4xl max-h-[92vh] flex flex-col"
        onClick={e => e.stopPropagation()}>
        <div className="px-6 pt-6 pb-4 border-b border-gray-100 flex items-start justify-between">
          <div>
            <h3 className="text-lg font-bold text-black mb-1">촬영 정보</h3>
            <p className="text-xs text-gray-500">{productName}</p>
          </div>
          {models.length === 0 && (
            <span className="text-[11px] text-amber-700 bg-amber-50 border border-amber-200 rounded px-2 py-1">
              활성 모델 없음 — 내정보 &gt; 모델 관리에서 추가하세요
            </span>
          )}
        </div>

        <div className="overflow-y-auto flex-1 px-6 py-5 space-y-5">
          {loading ? (
            <p className="text-xs text-gray-400 text-center py-6">불러오는 중...</p>
          ) : (
            <>
              {/* ── 입력 폼 (가로) ── */}
              <section className="border border-gray-200 rounded-lg p-4 space-y-3 bg-gray-50/40">
                <div className="flex items-center justify-between">
                  <h4 className="text-sm font-bold text-black">
                    {editingId ? "촬영 수정" : "새 촬영 등록"}
                  </h4>
                  {editingId && (
                    <button onClick={resetForm}
                      className="text-[11px] text-gray-500 hover:text-black underline">
                      ← 새로 등록
                    </button>
                  )}
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className={styles.modalLabel}>모델</label>
                    <select value={modelId} onChange={e => setModelId(e.target.value)}
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
                  <div>
                    <label className={styles.modalLabel}>촬영 날짜 <span className="text-gray-400">(선택)</span></label>
                    <input type="date" value={shootDate}
                      onChange={e => setShootDate(e.target.value)}
                      className={styles.modalInput} />
                  </div>
                </div>

                {/* 착용 옵션 칩 */}
                <div>
                  <label className={styles.modalLabel}>착용 옵션</label>
                  {ownVariants.length === 0 ? (
                    <p className="text-xs text-gray-400">등록된 옵션이 없습니다.</p>
                  ) : (
                    <div className="flex flex-wrap gap-1">
                      <button onClick={() => setWornVariantId("")}
                        className={`px-2 py-1 text-xs rounded border ${
                          wornVariantId === ""
                            ? "border-black bg-black text-white"
                            : "border-gray-300 text-gray-600 hover:bg-white"
                        }`}>
                        없음
                      </button>
                      {ownVariants.map(v => v.id && (
                        <button key={v.id} onClick={() => setWornVariantId(v.id!)}
                          className={`px-2 py-1 text-xs rounded border ${
                            wornVariantId === v.id
                              ? "border-black bg-black text-white"
                              : "border-gray-300 text-gray-700 hover:bg-white"
                          }`}>
                          {variantLabel(v)}
                        </button>
                      ))}
                    </div>
                  )}
                </div>

                {/* 코디 양방향 검색 */}
                <div>
                  <label className={styles.modalLabel}>코디 아이템 <span className="text-gray-400">(다른 상품 + 옵션)</span></label>
                  <div className="grid grid-cols-2 gap-3">
                    <CoordSearchColumn
                      title="내 상품명"
                      placeholder="consumer_name 검색"
                      value={searchOwn}
                      onChange={setSearchOwn}
                      results={ownResults}
                      labelFor={p => p.consumer_name || p.wholesale_name || "(이름 없음)"}
                      onPickVariant={addCoord}
                    />
                    <CoordSearchColumn
                      title="공급 상품명"
                      placeholder="wholesale_name 검색"
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
                            {p?.consumer_name || p?.wholesale_name || "(삭제됨)"}
                            {v && <span className="text-gray-500">· {variantLabel(v)}</span>}
                            <button onClick={() => removeCoord(idx)}
                              className="text-red-500 hover:text-red-700 ml-0.5">×</button>
                          </span>
                        );
                      })}
                    </div>
                  )}
                </div>

                <div>
                  <label className={styles.modalLabel}>메모 <span className="text-gray-400">(선택)</span></label>
                  <input value={memo} onChange={e => setMemo(e.target.value)}
                    placeholder="장소, 컨셉 등"
                    className={styles.modalInput} />
                </div>

                <div className="flex gap-2 pt-1">
                  {editingId && (
                    <button onClick={resetForm} disabled={saving}
                      className={styles.btnSecondary}>취소</button>
                  )}
                  <button onClick={handleSubmit} disabled={saving}
                    className={`${styles.btnPrimary} flex-1`}>
                    {saving ? "저장 중..." : editingId ? "수정 저장" : "+ 등록"}
                  </button>
                </div>
              </section>

              {/* ── 이력 listing (세로) ── */}
              <section>
                <h4 className="text-sm font-bold text-black mb-2">
                  촬영 이력 <span className="text-gray-400">({shoots.length}건)</span>
                </h4>
                {shoots.length === 0 ? (
                  <p className="text-xs text-gray-400 text-center py-4 border border-dashed border-gray-200 rounded">
                    아직 촬영 이력이 없습니다.
                  </p>
                ) : (
                  <ul className="divide-y divide-gray-100 border border-gray-200 rounded">
                    {shoots.map(s => {
                      const m = findModel(s.model_id);
                      const wv = ownVariantById(s.worn_variant_id);
                      const isEditing = editingId === s.id;
                      return (
                        <li key={s.id}
                          className={`px-3 py-2 ${isEditing ? "bg-amber-50" : "hover:bg-gray-50"}`}>
                          <div className="flex items-center gap-3 text-xs">
                            <span className="text-gray-500 w-24 shrink-0">
                              {s.shoot_date ?? new Date(s.created_at).toLocaleDateString("ko-KR")}
                            </span>
                            <span className="font-medium text-black w-24 shrink-0">
                              {m?.name ?? <span className="text-gray-400">모델 미지정</span>}
                            </span>
                            <span className="text-gray-700 w-32 shrink-0">
                              {wv ? variantLabel(wv) : <span className="text-gray-400">착용 미지정</span>}
                            </span>
                            <span className="text-gray-500 flex-1 truncate">
                              {s.coordinates.length > 0 && `코디 ${s.coordinates.length}개`}
                              {s.memo && ` · ${s.memo}`}
                            </span>
                            <button onClick={() => loadIntoForm(s)}
                              className="text-primary hover:underline text-xs">수정</button>
                            <button onClick={() => handleDelete(s.id)}
                              className="text-red-500 hover:underline text-xs">삭제</button>
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </section>
            </>
          )}
        </div>

        <div className="px-6 py-4 border-t border-gray-100 flex justify-end">
          <button onClick={onClose} className={styles.btnSecondary}>닫기</button>
        </div>
      </div>
    </div>
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
                    <button key={v.id}
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
