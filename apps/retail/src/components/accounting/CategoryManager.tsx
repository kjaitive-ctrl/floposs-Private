"use client";

// 계정과목 관리 — tenant 가 직접 만들고 관리. 엑셀 라벨을 그대로 박지 않고
// 사용자가 자기 사업 성격에 맞게 추가/삭제. type 만 골라주면 손익 리포트가 자동 집계.
import { useEffect, useState } from "react";
import { styles } from "@/common/styles";
import {
  ACCOUNT_TYPES, type AccountCategory, type AccountType,
  loadAccountCategories, addAccountCategory, deactivateAccountCategory, updateAccountCategoryGubun,
} from "@/lib/accounting";

// 빈 상태에서 클릭 한 번으로 추가할 수 있는 제안 — 강제 아님, 그냥 시작점.
const SUGGESTIONS: [string, AccountType][] = [
  ["매출", "매출"],
  ["상품매입", "매입원가"],
  ["급여", "인건비"],
  ["임차료", "판관비"],
  ["운반비", "판관비"],
  ["광고선전비", "판관비"],
  ["통신비", "판관비"],
  ["소모품비", "판관비"],
  ["세금과공과", "세금과공과"],
  ["가지급금", "자본거래"],
];

export default function CategoryManager({ tenantId }: { tenantId: string }) {
  const [categories, setCategories] = useState<AccountCategory[]>([]);
  const [loading, setLoading] = useState(true);
  const [name, setName] = useState("");
  const [type, setType] = useState<AccountType>("판관비");
  const [newGubun, setNewGubun] = useState<"자산" | "부채">("자산");
  const [busy, setBusy] = useState(false);

  async function refresh() {
    setLoading(true);
    setCategories(await loadAccountCategories(tenantId));
    setLoading(false);
  }

  useEffect(() => { refresh(); }, [tenantId]);

  async function handleAdd(n: string, t: AccountType, gubun?: "자산" | "부채") {
    const trimmed = n.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    const created = await addAccountCategory(tenantId, trimmed, t, t === "자본거래" ? (gubun ?? newGubun) : undefined);
    setBusy(false);
    if (created) {
      setCategories(prev => [...prev, created]);
      setName("");
    }
  }

  async function handleDelete(id: string) {
    if (!confirm("이 계정과목을 삭제할까요? (이미 입력된 거래는 유지되고 계정만 비워집니다)")) return;
    await deactivateAccountCategory(id);
    setCategories(prev => prev.filter(c => c.id !== id));
  }

  async function handleToggleGubun(c: AccountCategory) {
    const next = c.gubun === "자산" ? "부채" : "자산";
    await updateAccountCategoryGubun(c.id, next);
    setCategories(prev => prev.map(x => x.id === c.id ? { ...x, gubun: next } : x));
  }

  const existingNames = new Set(categories.map(c => c.name));

  return (
    <div className="space-y-6">
      <div className={styles.card}>
        <div className={styles.sectionLabel}>새 계정과목 추가</div>
        <form
          className="flex items-end gap-2"
          onSubmit={e => { e.preventDefault(); handleAdd(name, type); }}
        >
          <div className="flex-1">
            <label className={styles.modalLabel}>이름</label>
            <input
              className={styles.inputMd}
              placeholder="예: 상품매입, 임차료, 광고선전비..."
              value={name}
              onChange={e => setName(e.target.value)}
            />
          </div>
          <div className="w-40">
            <label className={styles.modalLabel}>손익 성격</label>
            <select className={styles.inputMd} value={type} onChange={e => setType(e.target.value as AccountType)}>
              {ACCOUNT_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
            </select>
          </div>
          {type === "자본거래" && (
            <div className="w-32">
              <label className={styles.modalLabel}>재무상태 분류</label>
              <select className={styles.inputMd} value={newGubun} onChange={e => setNewGubun(e.target.value as "자산" | "부채")}>
                <option value="자산">자산</option>
                <option value="부채">부채</option>
              </select>
            </div>
          )}
          <button type="submit" disabled={!name.trim() || busy} className={styles.btnPrimary}>추가</button>
        </form>

        <div className="mt-4">
          <div className="text-xs text-gray-400 mb-2">빠른 추가 (성격이 맞으면 클릭 한 번)</div>
          <div className="flex flex-wrap gap-2">
            {SUGGESTIONS.filter(([n]) => !existingNames.has(n)).map(([n, t]) => (
              <button
                key={n}
                type="button"
                disabled={busy}
                onClick={() => handleAdd(n, t)}
                className={styles.btnSmallGhost}
              >
                + {n}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className={styles.card}>
        <div className={styles.sectionLabel}>내 계정과목 ({categories.length})</div>
        {loading ? (
          <div className="text-xs text-gray-400">불러오는 중…</div>
        ) : categories.length === 0 ? (
          <div className="text-xs text-gray-400">아직 계정과목이 없어요. 위에서 추가해보세요.</div>
        ) : (
          <table className="w-full text-xs">
            <thead>
              <tr>
                <th className={styles.thLeft}>이름</th>
                <th className={styles.th}>손익 성격</th>
                <th className={styles.th}>재무상태 분류</th>
                <th className={styles.th}></th>
              </tr>
            </thead>
            <tbody>
              {categories.map(c => (
                <tr key={c.id} className={styles.tr}>
                  <td className={styles.tdText}>{c.name}</td>
                  <td className={styles.tdCenter}>
                    <span className={styles.badge + " " + (c.type === "매출" ? "bg-green-50 text-green-700" : c.type === "자본거래" ? "bg-gray-100 text-gray-600" : "bg-blue-50 text-blue-700")}>
                      {c.type}
                    </span>
                  </td>
                  <td className={styles.tdCenter}>
                    {c.type === "자본거래" ? (
                      <button type="button" onClick={() => handleToggleGubun(c)}
                        className={styles.badge + " " + (c.gubun === "자산" ? "bg-blue-50 text-blue-700" : "bg-amber-50 text-amber-700")}
                        title="클릭해서 자산/부채 전환">
                        {c.gubun} ⇄
                      </button>
                    ) : (
                      <span className="text-gray-400">{c.gubun}</span>
                    )}
                  </td>
                  <td className={styles.tdCenter}>
                    <button type="button" onClick={() => handleDelete(c.id)} className="text-gray-400 hover:text-red-600">삭제</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
