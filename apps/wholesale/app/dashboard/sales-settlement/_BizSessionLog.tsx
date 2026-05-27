"use client";

// 영업기록 리스트 — 추후 /sales-settlement/list 페이지에서 사용 예정.
// 현재 메인 영업정산 페이지(page.tsx)는 세션 상세 화면이라 여기엔 안 쓰임.
// import 시: <BizSessionLog tenantId={tenantId} onRowClick={(id) => ...} />

import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import { APP_TIMEZONE } from "@/lib/format";
import { DataTable, TableHead, Th, EmptyRow, LoadingRow, Badge } from "../_components/DataTable";

export type BizSession = {
  id: string;
  opener_name: string;
  opening_cash: number;
  opened_at: string;
  closer_name: string | null;
  closing_cash: number | null;
  closed_at: string | null;
  status: "open" | "closed";
};

function formatDateTime(iso: string) {
  return new Date(iso).toLocaleString("ko-KR", {
    timeZone: APP_TIMEZONE,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit",
  });
}

type Props = {
  tenantId: string;
  onRowClick?: (sessionId: string) => void;
};

export default function BizSessionLog({ tenantId, onRowClick }: Props) {
  const [sessions, setSessions] = useState<BizSession[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    supabase
      .from("biz_sessions")
      .select("id, opener_name, opening_cash, opened_at, closer_name, closing_cash, closed_at, status")
      .eq("tenant_id", tenantId)
      .order("opened_at", { ascending: false })
      .limit(200)
      .then(({ data }) => {
        if (!alive) return;
        if (data) setSessions(data as BizSession[]);
        setLoading(false);
      });
    return () => { alive = false; };
  }, [tenantId]);

  return (
    <DataTable>
      <TableHead>
        <Th>개시 일시</Th>
        <Th>정산 일시</Th>
        <Th className="w-20">상태</Th>
        <Th>근무자</Th>
        <Th className="text-right">개시시재</Th>
        <Th>마감자</Th>
        <Th className="text-right">마감시재</Th>
      </TableHead>
      <tbody>
        {loading ? (
          <LoadingRow colSpan={7} />
        ) : sessions.length === 0 ? (
          <EmptyRow colSpan={7} message="기록이 없습니다." />
        ) : sessions.map(s => (
          <tr
            key={s.id}
            className={`border-b border-gray-100 hover:bg-gray-50 ${onRowClick ? "cursor-pointer" : ""}`}
            onClick={() => onRowClick?.(s.id)}
          >
            <td className="px-4 py-3 text-center text-xs text-gray-500 whitespace-nowrap">
              {formatDateTime(s.opened_at)}
            </td>
            <td className="px-4 py-3 text-center text-xs text-gray-500 whitespace-nowrap">
              {s.closed_at ? formatDateTime(s.closed_at) : "-"}
            </td>
            <td className="px-4 py-3 text-center">
              <Badge color={s.status === "open" ? "blue" : "orange"}>
                {s.status === "open" ? "영업 중" : "정산완료"}
              </Badge>
            </td>
            <td className="px-4 py-3 text-center font-medium text-gray-800">{s.opener_name}</td>
            <td className="px-4 py-3 text-right font-medium text-gray-900">
              {s.opening_cash > 0 ? s.opening_cash.toLocaleString() + "원" : "-"}
            </td>
            <td className="px-4 py-3 text-center text-gray-700">{s.closer_name ?? "-"}</td>
            <td className="px-6 py-3 text-right font-medium text-gray-900">
              {s.closing_cash != null && s.closing_cash > 0 ? s.closing_cash.toLocaleString() + "원" : "-"}
            </td>
          </tr>
        ))}
      </tbody>
    </DataTable>
  );
}
