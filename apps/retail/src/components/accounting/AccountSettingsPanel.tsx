"use client";

// 설정 탭 — 계정과목(9분류) 관리. 표준 계정과목 시딩(이름 중복 시 건너뜀,
// 몇 번 눌러도 안전) + 이름/구분 인라인 수정 + 비활성화 + 직접 추가.
// 시스템계정(보통예금/부가세대급금/부가세예수금)은 목록에서 제외 —
// loadAccounts 기본 동작이 이미 그렇게 함. 마이그 230.
import { Fragment, useCallback, useEffect, useState } from "react";
import { styles } from "@/common/styles";
import {
  type Account, type Gubun, GUBUN_LIST,
  loadAccounts, addAccount, updateAccount, deactivateAccount, seedStandardAccounts,
} from "@/lib/accounting";

const GUBUN_ORDER: Gubun[] = ["유동자산", "비유동자산", "유동부채", "비유동부채", "자본", "매출", "매출원가", "판관비", "영업외손익"];

export default function AccountSettingsPanel({ tenantId }: { tenantId: string }) {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [loading, setLoading] = useState(true);
  const [seeding, setSeeding] = useState(false);
  const [seedMsg, setSeedMsg] = useState<string | null>(null);
  const [newName, setNewName] = useState("");
  const [newGubun, setNewGubun] = useState<Gubun>("판관비");
  const [addErr, setAddErr] = useState<string | null>(null);

  const loadAll = useCallback(async () => {
    setLoading(true);
    setAccounts(await loadAccounts(tenantId));
    setLoading(false);
  }, [tenantId]);
  useEffect(() => { loadAll(); }, [loadAll]);

  async function handleSeed() {
    setSeeding(true);
    setSeedMsg(null);
    const { added, error } = await seedStandardAccounts(tenantId);
    setSeeding(false);
    if (error) { setSeedMsg(error); return; }
    setSeedMsg(added > 0 ? `${added}개 계정을 새로 추가했어요.` : "추가할 계정이 없어요 — 이미 다 있어요.");
    loadAll();
  }

  async function handleAdd() {
    setAddErr(null);
    const trimmed = newName.trim();
    if (!trimmed) return;
    const created = await addAccount(tenantId, trimmed, newGubun);
    if (!created) { setAddErr("추가하지 못했어요 — 이미 있는 이름일 수 있어요."); return; }
    setNewName("");
    loadAll();
  }

  async function handleRename(acc: Account, name: string) {
    const trimmed = name.trim();
    if (!trimmed || trimmed === acc.name) return;
    const { error } = await updateAccount(acc.id, { name: trimmed });
    if (error) { alert(error); return; }
    setAccounts(prev => prev.map(a => a.id === acc.id ? { ...a, name: trimmed } : a));
  }

  async function handleRegubun(acc: Account, gubun: Gubun) {
    const { error } = await updateAccount(acc.id, { gubun });
    if (error) { alert(error); return; }
    setAccounts(prev => prev.map(a => a.id === acc.id ? { ...a, gubun } : a));
  }

  async function handleDeactivate(acc: Account) {
    if (!confirm(`"${acc.name}" 계정을 목록에서 지울까요? 이미 쓰인 전표는 그대로 남아요.`)) return;
    await deactivateAccount(acc.id);
    setAccounts(prev => prev.filter(a => a.id !== acc.id));
  }

  const grouped = GUBUN_ORDER.map(g => ({ gubun: g, list: accounts.filter(a => a.gubun === g).sort((a, b) => a.code - b.code) }));

  return (
    <div className={styles.cardSm}>
      <div className="flex items-center gap-3 mb-3">
        <div className={styles.sectionLabel + " mb-0"}>계정과목 ({accounts.length}개)</div>
        <button type="button" onClick={handleSeed} disabled={seeding} className={styles.btnSmallGhost}>
          {seeding ? "불러오는 중…" : "+ 표준 계정과목 불러오기"}
        </button>
        {seedMsg && <span className="text-xs text-gray-500">{seedMsg}</span>}
      </div>

      {loading ? (
        <div className="text-xs text-gray-400">불러오는 중…</div>
      ) : (
        <table className="w-full text-xs mb-4">
          <thead>
            <tr>
              <th className={styles.th}>코드</th>
              <th className={styles.thLeft}>이름</th>
              <th className={styles.th}>구분</th>
              <th className={styles.th}></th>
            </tr>
          </thead>
          <tbody>
            {accounts.length === 0 ? (
              <tr><td colSpan={4} className="text-center text-gray-400 py-6 text-xs">아직 계정과목이 없어요 — 위에서 표준 계정과목을 불러오거나 아래에서 직접 추가하세요.</td></tr>
            ) : (
              grouped.map(({ gubun, list }) => list.length === 0 ? null : (
                <Fragment key={gubun}>
                  <tr>
                    <td colSpan={4} className="px-2 pt-3 pb-1 text-xs font-semibold text-gray-400">{gubun}</td>
                  </tr>
                  {list.map(acc => (
                    <tr key={acc.id} className={styles.tr}>
                      <td className={styles.tdCenter + " text-gray-400"}>{acc.code}</td>
                      <td className={styles.tdText}>
                        <input defaultValue={acc.name} onBlur={e => handleRename(acc, e.target.value)} className={styles.gridInput} />
                      </td>
                      <td className={styles.tdCenter}>
                        <select value={acc.gubun} onChange={e => handleRegubun(acc, e.target.value as Gubun)} className={styles.gridInput}>
                          {GUBUN_LIST.map(g => <option key={g} value={g}>{g}</option>)}
                        </select>
                      </td>
                      <td className={styles.tdCenter}>
                        <button type="button" onClick={() => handleDeactivate(acc)} className="text-gray-400 hover:text-red-600">삭제</button>
                      </td>
                    </tr>
                  ))}
                </Fragment>
              ))
            )}
          </tbody>
        </table>
      )}

      <div className="flex items-center gap-2">
        <input value={newName} onChange={e => setNewName(e.target.value)} placeholder="새 계정 이름" className={styles.inputSm} />
        <select value={newGubun} onChange={e => setNewGubun(e.target.value as Gubun)} className={styles.inputSm}>
          {GUBUN_LIST.map(g => <option key={g} value={g}>{g}</option>)}
        </select>
        <button type="button" onClick={handleAdd} className={styles.btnSmallGhost}>+ 추가</button>
        {addErr && <span className="text-xs text-red-600">{addErr}</span>}
      </div>
    </div>
  );
}
