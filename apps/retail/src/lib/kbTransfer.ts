// 국민은행 대량이체 엑셀 (뼈대) — 주문 탭 입고분을 거래처별로 합쳐 업로드 파일을 만듦.
// 양식: 제목줄 없이 1행부터 데이터, A~K 11칸. 은행코드·계좌번호는 텍스트, 금액은 정수.
// DB 에는 아무것도 기록하지 않음 (송금 여부 관리는 아직 없음).
import * as XLSX from "xlsx";
import type { OrderItem } from "@/lib/purchaseOrder";

// 금융기관 공동코드 (2026-02-26 기준) 중 은행. [코드, 표시 이름, 다른 표기들]
// 농협은 011/012 둘 다 "농협은행" — 은행 양식의 주요 은행 "농협"은 011 이라 기본은 011.
const BANKS: [string, string, string[]][] = [
  ["004", "국민은행", ["국민", "KB", "KB국민", "KB국민은행"]],
  ["088", "신한은행", ["신한", "조흥은행"]],
  ["020", "우리은행", ["우리"]],
  ["081", "하나은행", ["하나", "KEB하나", "KEB하나은행", "외환은행", "외환"]],
  ["011", "농협은행", ["농협", "NH", "NH농협", "NH농협은행", "농협중앙회"]],
  ["012", "지역농협", ["지역농축협", "단위농협", "축협", "농축협"]],
  ["003", "기업은행", ["기업", "IBK", "IBK기업", "IBK기업은행"]],
  ["090", "카카오뱅크", ["카카오", "카뱅"]],
  ["092", "토스뱅크", ["토스"]],
  ["089", "케이뱅크", ["K뱅크", "KBANK"]],
  ["045", "새마을금고", ["새마을", "MG새마을금고", "MG"]],
  ["048", "신협", ["신용협동조합", "신협은행"]],
  ["071", "우체국", ["우체국은행"]],
  ["007", "수협은행", ["수협"]],
  ["023", "SC제일은행", ["SC", "SC제일", "제일은행", "제일", "스탠다드차타드", "스탠다드차타드은행"]],
  ["027", "한국씨티은행", ["씨티", "씨티은행", "시티은행"]],
  ["031", "아이엠뱅크", ["IM뱅크", "대구은행", "대구"]],
  ["032", "부산은행", ["부산", "BNK부산은행"]],
  ["039", "경남은행", ["경남", "BNK경남은행"]],
  ["034", "광주은행", ["광주"]],
  ["037", "전북은행", ["전북"]],
  ["035", "제주은행", ["제주"]],
  ["002", "산업은행", ["산업", "KDB", "KDB산업은행"]],
  ["050", "저축은행", ["상호저축은행"]],
  ["064", "산림조합", ["산림조합중앙회"]],
  ["054", "HSBC은행", ["HSBC"]],
];

export const BANK_NAMES = BANKS.map(([, name]) => name);

const normBank = (s: string) => s.replace(/\s|\(주\)|㈜/g, "").toUpperCase();
const CODE_BY_NAME = new Map<string, string>(
  BANKS.flatMap(([code, name, aliases]) => [name, ...aliases, code].map(n => [normBank(n), code] as [string, string]))
);

// 은행명(또는 3자리 코드) → 3자리 코드. 정확히 아는 표기만 — 모르면 null (추측하지 않음).
export function bankCode(name: string): string | null {
  return CODE_BY_NAME.get(normBank(name)) ?? null;
}

export interface TransferGroup {
  supplier: string;
  lines: number;
  quantity: number;
  amount: number;
  noPrice: number; // 단가 없는 줄 수
  claims: number;  // 반품·교환 표시된 줄 수 (금액에서 자동으로 빼지 않음)
}

// 들어온 줄(입고·즉시출고 모두 입고수량이 적힘) 중 이체 건을 거래처별로 합산. 금액 = 단가 × 입고수량.
export function groupReceived(items: OrderItem[], includeSamples: boolean): TransferGroup[] {
  const map = new Map<string, TransferGroup>();
  for (const item of items) {
    const received = item.received_quantity ?? 0;
    if (received <= 0 || item.payment_method === "cash") continue;
    if (item.is_sample_request && !includeSamples) continue;
    const supplier = (item.supplier_name ?? "").trim() || "미지정";
    const g = map.get(supplier) ?? { supplier, lines: 0, quantity: 0, amount: 0, noPrice: 0, claims: 0 };
    g.lines += 1;
    g.quantity += received;
    g.amount += (item.unit_price ?? 0) * received;
    if (!item.unit_price) g.noPrice += 1;
    if (item.claim_type) g.claims += 1;
    map.set(supplier, g);
  }
  return Array.from(map.values()).sort((a, b) => a.supplier.localeCompare(b.supplier, "ko"));
}

export interface TransferRow {
  code: string;
  account: string;
  amount: number;
  holder: string;
  receiverMemo: string; // 받는 분 통장 표시 (10자)
  senderMemo: string;   // 내 통장 표시 (14자)
}

const cut = (s: string, n: number) => Array.from(s.trim()).slice(0, n).join("");

export function buildTransferWorkbook(rows: TransferRow[]): XLSX.WorkBook {
  const ws = XLSX.utils.aoa_to_sheet(rows.map(r => [
    r.code,
    r.account.replace(/[^0-9]/g, ""),
    r.amount,
    cut(r.holder.replace(/\s/g, ""), 20), // 띄어쓰기가 있으면 예금주 조회가 안 맞음
    cut(r.receiverMemo, 10),
    cut(r.senderMemo, 14),
    // G~K (CMS 1~3 · 수수료 · 메모) 는 비움 — 수수료는 비우면 보내는 쪽 부담
  ]));
  rows.forEach((_, i) => {
    for (const col of ["A", "B", "D", "E", "F"]) ws[`${col}${i + 1}`].z = "@";
    ws[`C${i + 1}`].z = "0";
  });
  ws["!cols"] = [8, 20, 12, 14, 14, 16].map(wch => ({ wch }));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "대량이체");
  return wb;
}

export function downloadTransferFile(rows: TransferRow[], date: string) {
  XLSX.writeFile(buildTransferWorkbook(rows), `국민은행_대량이체_${date}.xls`, { bookType: "biff8" });
}
