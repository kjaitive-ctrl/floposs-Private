"use client";

import { useState } from "react";
import Modal from "./Modal";
import NumberInput from "@/components/NumberInput";
import { supabase } from "@/lib/supabase";
import { APP_TIMEZONE } from "@/lib/format";

export type BizLog = {
  id: string;
  opener_name: string;
  opening_cash: number;
  opened_at: string;
  closer_name: string | null;
  closing_cash: number | null;
  closed_at: string | null;
  status: "open" | "closed";
};

type Props = {
  tenantId: string;
  onClose: () => void;
  onSuccess: (bizSessionId: string, log: BizLog) => void;
};

export default function BizSessionOpenModal({ tenantId, onClose, onSuccess }: Props) {
  const [amount, setAmount] = useState<number | "">("");
  const [workerName, setWorkerName] = useState("");
  const [saving, setSaving] = useState(false);

  async function handleOpen() {
    if (!workerName.trim()) return alert("근무자 이름을 입력해주세요.");
    setSaving(true);

    const { data: bizSession, error } = await supabase
      .from("biz_sessions")
      .insert({
        tenant_id: tenantId,
        opener_name: workerName.trim(),
        opening_cash: amount || 0,
      })
      .select("id, opener_name, opening_cash, opened_at, closer_name, closing_cash, closed_at, status")
      .single();

    setSaving(false);

    if (error || !bizSession) return alert("영업개시 저장 실패: " + (error?.message ?? ""));

    onSuccess(bizSession.id, bizSession as BizLog);
  }

  return (
    <Modal onClose={() => !saving && onClose()} size="sm">
      <div className="p-5 border-b border-gray-100">
        <h3 className="text-lg font-bold text-gray-900">영업 개시</h3>
        <p className="text-sm text-gray-500 mt-0.5">
          {new Date().toLocaleDateString("ko-KR", { timeZone: APP_TIMEZONE, year: "numeric", month: "long", day: "numeric", weekday: "short" })}
        </p>
      </div>

      <div className="p-5 space-y-4">
        <div>
          <label className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2 block">
            시재 (돈통)
          </label>
          <NumberInput value={amount} onChange={setAmount} placeholder="0" autoFocus />
        </div>

        <div>
          <label className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2 block">
            근무자
          </label>
          <input
            type="text"
            value={workerName}
            onChange={e => setWorkerName(e.target.value)}
            onKeyDown={e => e.key === "Enter" && handleOpen()}
            placeholder="이름 입력"
            className="w-full px-4 py-2.5 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary-ring"
          />
        </div>
      </div>

      <div className="flex gap-2 p-5 border-t border-gray-100">
        <button onClick={onClose} disabled={saving}
          className="flex-1 py-2.5 border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50 text-sm">
          취소
        </button>
        <button onClick={handleOpen} disabled={saving || !workerName.trim()}
          className="flex-1 py-2.5 bg-primary text-white rounded-lg hover:bg-primary-hover disabled:opacity-50 font-medium text-sm">
          {saving ? "개시 중..." : "확인 (개시)"}
        </button>
      </div>
    </Modal>
  );
}
