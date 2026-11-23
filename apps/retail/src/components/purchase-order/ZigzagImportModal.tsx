"use client";

// 지그재그 주문 엑셀 → 주문서 미리보기. 파일을 고르면 상품을 찾아 보여주고,
// 틀린 건 여기서 상품을 바꾸거나 [미분류로] 돌린 뒤 [주문서 만들기]로 저장. 마이그 246.
// 연결된 상품에는 지그재그 상품번호를 저장 → 다음 업로드부터 그 번호로 바로 찾음.
import { useMemo, useState } from "react";
import { styles } from "@/common/styles";
import { formatComma } from "@/lib/format";
import ProductPickerCombobox from "@/components/purchase-order/ProductPickerCombobox";
import type { OrderItem } from "@/lib/purchaseOrder";
import {
  type MatchMethod, type ZigzagGroup, type ZigzagProduct, METHOD_LABEL,
  parseZigzagFile, isCancelled, loadZigzagProducts, groupAndMatch, planLines, insertLines, rememberZigzagNo, shortOption,
} from "@/lib/zigzagImport";

const METHOD_STYLE: Record<MatchMethod, string> = {
  zigzag: "bg-emerald-50 text-emerald-700",
  cafe24: "bg-emerald-50 text-emerald-700",
  code: "bg-emerald-50 text-emerald-700",
  name: "bg-emerald-50 text-emerald-700",
  similar: "bg-amber-100 text-amber-800",
  manual: "bg-sky-50 text-sky-700",
  none: "bg-red-50 text-red-600",
};

interface Props {
  tenantId: string;
  existingOrderNos: Set<string>;
  onClose: () => void;
  onDone: (items: OrderItem[], summary: string) => void;
}

export default function ZigzagImportModal({ tenantId, existingOrderNos, onClose, onDone }: Props) {
  const [products, setProducts] = useState<ZigzagProduct[]>([]);
  const [groups, setGroups] = useState<ZigzagGroup[]>([]);
  const [texts, setTexts] = useState<Record<number, string>>({}); // 상품 고르기 칸 입력 중 글자
  const [counts, setCounts] = useState<{ total: number; skipped: number; cancelled: number } | null>(null);
  const [fileName, setFileName] = useState("");
  const [busy, setBusy] = useState<"read" | "save" | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function handleFile(file: File | null) {
    if (!file) return;
    setBusy("read");
    setError(null);
    setGroups([]);
    setCounts(null);
    setFileName(file.name);
    try {
      const rows = await parseZigzagFile(file);
      const cancelled = rows.filter(isCancelled);
      const live = rows.filter(r => !isCancelled(r));
      const fresh = live.filter(r => !existingOrderNos.has(r.order_no));
      const prods = await loadZigzagProducts(tenantId);
      setProducts(prods);
      setGroups(groupAndMatch(fresh, prods));
      setTexts({});
      setCounts({ total: rows.length, skipped: live.length - fresh.length, cancelled: cancelled.length });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  function setGroupProduct(i: number, product: ZigzagProduct | null) {
    setGroups(prev => prev.map((g, j) => j === i ? { ...g, product, method: product ? "manual" : "none", note: undefined } : g));
    setTexts(prev => { const next = { ...prev }; delete next[i]; return next; });
  }

  const lines = useMemo(() => planLines(groups), [groups]);
  const orderCount = groups.reduce((a, g) => a + g.rows.length, 0);
  const unassigned = groups.filter(g => !g.product).length;
  const optionMissing = lines.filter(l => !l.optionMatched).length;

  async function handleSave() {
    if (lines.length === 0 || busy) return;
    setBusy("save");
    setError(null);
    const { items, error: err } = await insertLines(tenantId, lines);
    if (err) { setError(`저장 실패: ${err}`); setBusy(null); return; }
    // 연결된 상품에 지그재그 상품번호 기억 (이미 번호로 찾은 건 제외)
    const learnErrors: string[] = [];
    for (const g of groups) {
      if (!g.product || !g.product_no || g.method === "zigzag") continue;
      const e = await rememberZigzagNo(g.product.id, g.product_no);
      if (e) learnErrors.push(e);
    }
    setBusy(null);
    const summary = [
      `지그재그 주문 ${orderCount}건 → 주문서 ${items.length}줄`,
      unassigned ? `미분류 ${unassigned}종` : "",
      optionMissing ? `옵션 확인 ${optionMissing}줄(메모 참고)` : "",
      counts?.skipped ? `이미 올린 ${counts.skipped}건 건너뜀` : "",
      learnErrors.length ? `상품번호 기억 실패 ${learnErrors.length}건` : "",
    ].filter(Boolean).join(" · ");
    onDone(items, summary);
  }

  return (
    <div className={styles.modalOverlay} onMouseDown={e => { if (e.target === e.currentTarget && !busy) onClose(); }}>
      <div className={styles.modalContent + " !max-w-6xl"}>
        <div className={styles.modalHeader + " flex items-center gap-3"}>
          <h2 className="text-base font-bold text-black">지그재그 주문 엑셀 → 주문서</h2>
          <label className={styles.btnSmall + " bg-white cursor-pointer"}>
            {busy === "read" ? "읽는 중…" : fileName ? "다른 파일" : "엑셀 파일 고르기"}
            <input type="file" accept=".xlsx,.xls" className="hidden" disabled={!!busy}
              onChange={e => { handleFile(e.currentTarget.files?.[0] ?? null); e.currentTarget.value = ""; }} />
          </label>
          {fileName && <span className="text-xs text-gray-500 truncate">{fileName}</span>}
          <button type="button" onClick={onClose} disabled={!!busy} className="ml-auto text-gray-400 hover:text-black">✕</button>
        </div>

        <div className={styles.modalBody}>
          {!counts && !error && (
            <div className="text-xs text-gray-500 leading-relaxed">
              지그재그 판매자센터 → 배송준비중 주문 엑셀(order_item_list)을 고르세요.<br />
              상품을 찾아 미리 보여드리고, [주문서 만들기]를 눌러야 저장됩니다. 같은 상품·옵션은 한 줄로 합치고, 이미 올린 주문은 건너뜁니다.
            </div>
          )}
          {error && <div className={styles.msgError}>{error}</div>}
          {counts && (
            <div className="text-xs text-gray-600">
              엑셀 {counts.total}건 · 새 주문 <b className="text-black">{orderCount}건</b>
              {counts.skipped > 0 && <> · 이미 올린 {counts.skipped}건 건너뜀</>}
              {counts.cancelled > 0 && <> · 취소·반품 {counts.cancelled}건 제외</>}
            </div>
          )}
          {counts && groups.length === 0 && (
            <div className={styles.msgWarn}>새로 넣을 주문이 없습니다.</div>
          )}
          {groups.length > 0 && (
            <div className="overflow-x-auto border border-gray-200 rounded-lg">
              <table className="w-full text-xs border-collapse">
                <thead>
                  <tr className="bg-gray-50">
                    <th className={styles.thLeft}>지그재그 상품명</th>
                    <th className={styles.thLeft}>주문 (옵션 × 수량)</th>
                    <th className={styles.thLeft + " min-w-[240px]"}>찾은 상품</th>
                    <th className={styles.thLeft}>거래처 · 단가</th>
                    <th className={styles.th}>찾은 방법</th>
                  </tr>
                </thead>
                <tbody>
                  {groups.map((g, i) => {
                    const byOpt = new Map<string, number>();
                    g.rows.forEach(r => { const k = shortOption(r.option); byOpt.set(k, (byOpt.get(k) ?? 0) + r.qty); });
                    return (
                      <tr key={g.product_no || g.name} className={styles.tr + (g.product ? "" : " bg-red-50/40")}>
                        <td className="px-2 py-1.5 text-black">{g.name}</td>
                        <td className="px-2 py-1.5 text-gray-600">
                          {Array.from(byOpt.entries()).map(([k, n]) => <div key={k} className="whitespace-nowrap">{k} × {n}</div>)}
                        </td>
                        <td className="px-1 py-1">
                          <div className="flex items-center gap-1">
                            <div className="flex-1 min-w-0">
                              <ProductPickerCombobox
                                products={products}
                                value={texts[i] ?? g.product?.consumer_name ?? g.product?.wholesale_name ?? ""}
                                onTextChange={t => setTexts(prev => ({ ...prev, [i]: t }))}
                                onPick={p => setGroupProduct(i, products.find(x => x.id === p.id) ?? null)}
                                onBlurCommit={() => setTexts(prev => { const next = { ...prev }; delete next[i]; return next; })}
                              />
                            </div>
                            {g.product && (
                              <button type="button" onClick={() => setGroupProduct(i, null)} title="이 상품이 아니면 미분류로"
                                className={styles.btnSmallGhost + " whitespace-nowrap"}>미분류로</button>
                            )}
                          </div>
                          {g.note && <div className="px-1 pt-0.5 text-[11px] text-gray-500">{g.note}</div>}
                        </td>
                        <td className="px-2 py-1.5 text-gray-600 whitespace-nowrap">
                          {g.product
                            ? <>{g.product.wholesale_supplier || "미지정"} · {formatComma(g.product.effective_price)}</>
                            : <span className="text-red-600">미분류</span>}
                        </td>
                        <td className="px-2 py-1.5 text-center">
                          <span className={"inline-block px-1.5 py-px rounded text-[11px] font-medium whitespace-nowrap " + METHOD_STYLE[g.method]}>
                            {METHOD_LABEL[g.method]}
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <div className={styles.modalFooter + " items-center"}>
          {groups.length > 0 && (
            <span className="text-xs text-gray-600">
              주문서 <b className="text-black">{lines.length}줄</b>
              {unassigned > 0 && <> · <span className="text-red-600">미분류 {unassigned}종</span></>}
              {optionMissing > 0 && <> · 옵션 못 찾은 {optionMissing}줄 (메모에 원래 옵션)</>}
              {groups.some(g => g.method === "similar") && <> · <span className="text-amber-700">비슷한 이름</span>은 확인해 주세요</>}
            </span>
          )}
          <button type="button" onClick={onClose} disabled={!!busy} className={styles.btnSecondary + " ml-auto"}>닫기</button>
          <button type="button" onClick={handleSave} disabled={lines.length === 0 || !!busy} className={styles.btnPrimary}>
            {busy === "save" ? "만드는 중…" : `주문서 ${lines.length}줄 만들기`}
          </button>
        </div>
      </div>
    </div>
  );
}
