"use client";

import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import { getOrCreateTenantId } from "@/lib/tenant";
import { formatProductNo } from "@/lib/format";
import Button from "./Button";
import Modal from "./Modal";

type FabricDetail = { part: string; fabric: string };
type Variant = { color: string; size: string };

export type Product = {
  id: string;
  name: string;
  product_no: number | null;
  product_code: string | null;
  category: string | null;
  base_price: number;
  cost_price: number | null;
  sale_price: number | null;
  is_sale: boolean;
  material_composition: Record<string, number>;
  fabric_details: FabricDetail[];
  manufacturer: string | null;
  designer: string | null;
  fabric_source: string | null;
  country_of_origin: string | null;
  launch_date: string | null;
  is_active: boolean;
  description: string | null;
};

const emptyForm = {
  name: "", product_code: "", category: "", base_price: 0, cost_price: 0, sale_price: 0,
  material_composition: "",
  fabric_details: [{ part: "", fabric: "" }] as FabricDetail[],
  manufacturer: "", designer: "", fabric_source: "", country_of_origin: "",
  launch_date: "", description: "", colors: "", sizes: "",
};

type Props = {
  editing: Product | null;
  categories: string[];
  onClose: () => void;
  onSaved: () => void;
  onCategoryAdded: (name: string) => void;
};

export default function ProductModal({ editing, categories, onClose, onSaved, onCategoryAdded }: Props) {
  const [form, setForm] = useState(emptyForm);
  const [saving, setSaving] = useState(false);
  const [addingCategory, setAddingCategory] = useState(false);
  const [newCategoryName, setNewCategoryName] = useState("");

  useEffect(() => {
    if (editing) {
      setForm({
        name: editing.name,
        product_code: editing.product_code || "",
        category: editing.category || "",
        base_price: editing.base_price,
        cost_price: editing.cost_price || 0,
        sale_price: editing.sale_price || 0,
        material_composition: Object.entries(editing.material_composition || {})
          .map(([k, v]) => `${k} ${v}%`).join(", "),
        fabric_details: editing.fabric_details?.length ? editing.fabric_details : [{ part: "", fabric: "" }],
        manufacturer: editing.manufacturer || "",
        designer: editing.designer || "",
        fabric_source: editing.fabric_source || "",
        country_of_origin: editing.country_of_origin || "",
        launch_date: editing.launch_date || "",
        description: editing.description || "",
        colors: "",
        sizes: "",
      });
    } else {
      setForm(emptyForm);
    }
  }, [editing]);

  function getVariantCombinations(): Variant[] {
    const colors = form.colors.split(",").map(c => c.trim()).filter(Boolean);
    const sizes = form.sizes.split(",").map(s => s.trim()).filter(Boolean);
    if (colors.length === 0 && sizes.length === 0) return [];
    if (colors.length === 0) return sizes.map(size => ({ color: "", size }));
    if (sizes.length === 0) return colors.map(color => ({ color, size: "" }));
    return colors.flatMap(color => sizes.map(size => ({ color, size })));
  }

  const variantPreview = getVariantCombinations();

  function parseMaterial(str: string): Record<string, number> {
    const result: Record<string, number> = {};
    str.split(",").forEach(item => {
      const match = item.trim().match(/^(.+?)\s+(\d+)%?$/);
      if (match) result[match[1].trim()] = Number(match[2]);
    });
    return result;
  }

  async function handleAddCategory() {
    const name = newCategoryName.trim();
    if (!name) return;
    const tenantId = await getOrCreateTenantId();
    if (!tenantId) return;
    const { error } = await supabase.from("product_categories").insert({ tenant_id: tenantId, name });
    if (error && !error.message.includes("unique")) { alert(error.message); return; }
    onCategoryAdded(name);
    setForm(f => ({ ...f, category: name }));
    setNewCategoryName("");
    setAddingCategory(false);
  }

  async function handleSave() {
    if (!form.name.trim()) return alert("상품명을 입력해주세요.");
    setSaving(true);
    const tenantId = await getOrCreateTenantId();
    if (!tenantId) { alert("사용자 정보 오류"); setSaving(false); return; }

    const payload = {
      tenant_id: tenantId,
      name: form.name,
      product_code: form.product_code || null,
      category: form.category || null,
      base_price: form.base_price,
      cost_price: form.cost_price || null,
      sale_price: form.sale_price || null,
      is_sale: form.sale_price > 0,
      material_composition: parseMaterial(form.material_composition),
      fabric_details: form.fabric_details.filter(f => f.part || f.fabric),
      manufacturer: form.manufacturer || null,
      designer: form.designer || null,
      fabric_source: form.fabric_source || null,
      country_of_origin: form.country_of_origin || null,
      launch_date: form.launch_date || null,
      description: form.description || null,
    };

    if (editing) {
      const { error } = await supabase.from("products").update(payload).eq("id", editing.id);
      if (error) { alert(error.message); setSaving(false); return; }
    } else {
      const { data, error } = await supabase.from("products").insert(payload).select("id").single();
      if (error) { alert(error.message); setSaving(false); return; }
      const combinations = getVariantCombinations();
      if (combinations.length > 0) {
        await supabase.from("product_variants").insert(
          combinations.map(v => ({ product_id: data.id, color: v.color || null, size: v.size || null }))
        );
      }
    }

    setSaving(false);
    onSaved();
  }

  return (
    <Modal onClose={onClose} size="2xl">
      <div className="p-6">
        <h3 className="text-lg font-bold text-gray-900 mb-4">{editing ? "상품 수정" : "상품 등록"}</h3>

        <div className="space-y-5">
          {/* 기본정보 */}
          <div>
            <p className="text-xs font-semibold text-gray-400 uppercase mb-2">기본 정보</p>
            <div className="grid grid-cols-2 gap-3">
              <div className="col-span-2">
                <label className="block text-xs font-medium text-gray-600 mb-1">상품명 *</label>
                <input type="text" value={form.name}
                  onChange={e => setForm({ ...form, name: e.target.value })}
                  className="w-full input-md" />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">상품번호 <span className="text-gray-400 font-normal">(자동)</span></label>
                <div className="px-3 py-2 bg-gray-50 border border-gray-200 rounded-lg text-sm text-gray-500 font-mono">
                  {editing?.product_no != null ? formatProductNo(editing.product_no) : "저장 시 자동 부여"}
                </div>
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">품번 <span className="text-gray-400 font-normal">(내부관리용)</span></label>
                <input type="text" value={form.product_code}
                  onChange={e => setForm({ ...form, product_code: e.target.value })}
                  placeholder="예) A-001"
                  className="w-full input-md" />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">카테고리</label>
                {addingCategory ? (
                  <div className="flex gap-1.5">
                    <input type="text" value={newCategoryName} autoFocus
                      onChange={e => setNewCategoryName(e.target.value)}
                      onKeyDown={e => { if (e.key === "Enter") handleAddCategory(); if (e.key === "Escape") setAddingCategory(false); }}
                      placeholder="카테고리명 입력"
                      className="flex-1 px-3 py-2 border border-primary-ring rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary-ring" />
                    <Button size="sm" onClick={handleAddCategory}>등록</Button>
                    <Button variant="secondary" size="sm" onClick={() => { setAddingCategory(false); setNewCategoryName(""); }}>취소</Button>
                  </div>
                ) : (
                  <div className="flex gap-1.5">
                    <select value={form.category}
                      onChange={e => setForm({ ...form, category: e.target.value })}
                      className="flex-1 input-md">
                      <option value="">카테고리 선택</option>
                      {categories.map(cat => <option key={cat} value={cat}>{cat}</option>)}
                    </select>
                    <button onClick={() => setAddingCategory(true)}
                      className="px-3 py-2 border border-gray-300 text-gray-500 text-xs rounded-lg hover:bg-gray-50 whitespace-nowrap">
                      + 추가
                    </button>
                  </div>
                )}
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">출시일</label>
                <input type="date" value={form.launch_date}
                  onChange={e => setForm({ ...form, launch_date: e.target.value })}
                  className="w-full input-md" />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">기본단가 (원)</label>
                <input type="number" value={form.base_price}
                  onChange={e => setForm({ ...form, base_price: Number(e.target.value) })}
                  className="w-full input-md" />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">세일단가 (원)</label>
                <input type="number" value={form.sale_price}
                  onChange={e => setForm({ ...form, sale_price: Number(e.target.value) })}
                  className="w-full input-md" />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">원가 (원)</label>
                <input type="number" value={form.cost_price}
                  onChange={e => setForm({ ...form, cost_price: Number(e.target.value) })}
                  className="w-full input-md" />
              </div>
            </div>
          </div>

          {/* 색상/사이즈 (신규만) */}
          {!editing && (
            <div>
              <p className="text-xs font-semibold text-gray-400 uppercase mb-2">색상 / 사이즈 옵션</p>
              <div className="grid grid-cols-2 gap-3 mb-3">
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">색상 (쉼표로 구분)</label>
                  <input type="text" placeholder="블랙, 화이트, 네이비" value={form.colors}
                    onChange={e => setForm({ ...form, colors: e.target.value })}
                    className="w-full input-md" />
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">사이즈 (쉼표로 구분)</label>
                  <input type="text" placeholder="S, M, L, XL 또는 F" value={form.sizes}
                    onChange={e => setForm({ ...form, sizes: e.target.value })}
                    className="w-full input-md" />
                </div>
              </div>
              {variantPreview.length > 0 && (
                <div className="bg-gray-50 rounded-lg p-3">
                  <p className="text-xs text-gray-500 mb-2">생성될 옵션 ({variantPreview.length}개)</p>
                  <div className="flex flex-wrap gap-1">
                    {variantPreview.map((v, i) => (
                      <span key={i} className="px-2 py-1 bg-white border border-gray-200 rounded text-xs text-gray-700">
                        {[v.color, v.size].filter(Boolean).join(" / ")}
                      </span>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* 소재 정보 */}
          <div>
            <p className="text-xs font-semibold text-gray-400 uppercase mb-2">소재 정보</p>
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">혼용율 (예: 면 80%, 폴리 20%)</label>
              <input type="text" value={form.material_composition} placeholder="면 80%, 폴리 20%"
                onChange={e => setForm({ ...form, material_composition: e.target.value })}
                className="w-full input-md" />
            </div>
          </div>

          {/* 원단 정보 */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <p className="text-xs font-semibold text-gray-400 uppercase">원단 정보</p>
              <span className="text-xs text-gray-400">원단명 칸에서 Enter → 행 추가</span>
            </div>
            <div className="space-y-2">
              {form.fabric_details.map((fd, i) => (
                <div key={i} className="flex gap-2 items-center">
                  <input type="text" placeholder="부위 (예: 카라)" value={fd.part}
                    onChange={e => {
                      const updated = [...form.fabric_details];
                      updated[i] = { ...updated[i], part: e.target.value };
                      setForm({ ...form, fabric_details: updated });
                    }}
                    className="w-1/3 input-md" />
                  <input type="text" placeholder="원단명" value={fd.fabric}
                    onChange={e => {
                      const updated = [...form.fabric_details];
                      updated[i] = { ...updated[i], fabric: e.target.value };
                      setForm({ ...form, fabric_details: updated });
                    }}
                    onKeyDown={e => {
                      if (e.key === "Enter")
                        setForm({ ...form, fabric_details: [...form.fabric_details, { part: "", fabric: "" }] });
                    }}
                    className="flex-1 input-md" />
                  {form.fabric_details.length > 1 && (
                    <button onClick={() => setForm({ ...form, fabric_details: form.fabric_details.filter((_, idx) => idx !== i) })}
                      className="text-red-400 hover:text-red-600 text-lg leading-none">×</button>
                  )}
                </div>
              ))}
            </div>
          </div>

          {/* 생산 정보 */}
          <div>
            <p className="text-xs font-semibold text-gray-400 uppercase mb-2">생산 정보</p>
            <div className="grid grid-cols-2 gap-3">
              {([
                { label: "제조공장", key: "manufacturer" },
                { label: "담당디자이너", key: "designer" },
                { label: "원단처", key: "fabric_source" },
                { label: "제조국가", key: "country_of_origin" },
              ] as { label: string; key: keyof typeof emptyForm }[]).map(({ label, key }) => (
                <div key={key}>
                  <label className="block text-xs font-medium text-gray-600 mb-1">{label}</label>
                  <input type="text" value={form[key] as string}
                    onChange={e => setForm({ ...form, [key]: e.target.value })}
                    className="w-full input-md" />
                </div>
              ))}
            </div>
          </div>

          {/* 메모 */}
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">메모</label>
            <textarea value={form.description} onChange={e => setForm({ ...form, description: e.target.value })}
              rows={2}
              className="w-full input-md" />
          </div>
        </div>

        <div className="flex gap-2 mt-5">
          <button onClick={onClose}
            className="flex-1 py-2 border border-gray-300 text-gray-700 text-sm rounded-lg hover:bg-gray-50">취소</button>
          <button onClick={handleSave} disabled={saving}
            className="flex-1 py-2 bg-primary text-white text-sm rounded-lg hover:bg-primary-hover disabled:opacity-50">
            {saving ? "저장 중..." : "저장"}
          </button>
        </div>
      </div>
    </Modal>
  );
}
