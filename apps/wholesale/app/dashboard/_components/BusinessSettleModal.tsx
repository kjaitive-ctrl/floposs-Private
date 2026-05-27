"use client";

import { useState } from "react";
import Modal from "./Modal";
import NumberInput from "@/components/NumberInput";
import { supabase } from "@/lib/supabase";
import { APP_TIMEZONE } from "@/lib/format";
import type { BizLog } from "./BizSessionOpenModal";

type Props = {
  onClose: () => void;
  onSuccess: (log: BizLog) => void;
};

export default function BusinessSettleModal({ onClose, onSuccess }: Props) {
  const [amount, setAmount] = useState<number | "">("");
  const [workerName, setWorkerName] = useState("");
  const [saving, setSaving] = useState(false);

  async function handleSettle() {
    if (!workerName.trim()) return alert("마감자 이름을 입력해주세요.");
    const bizSessionId = localStorage.getItem("biz_session_id");
    if (!bizSessionId) return alert("영업 세션을 찾을 수 없습니다. 영업개시 후 다시 시도해주세요.");
    setSaving(true);
    // settle_biz_session RPC: 마감 정보 update + 통계 박제(스칼라/거래처별/상품별) 단일 트랜잭션
    const { data: log, error } = await supabase
      .rpc("settle_biz_session", {
        p_biz_session_id: bizSessionId,
        p_closer_name:    workerName.trim(),
        p_closing_cash:   amount || 0,
      })
      .single();
    setSaving(false);
    if (error || !log) return alert("정산 실패: " + (error?.message ?? ""));
    onSuccess(log as BizLog);
  }

  return (
    <Modal onClose={() => !saving && onClose()} size="sm">
      <div className="p-5 border-b border-gray-100">
        <h3 className="text-lg font-bold text-orange-600">영업 정산</h3>
        <p className="text-sm text-gray-500 mt-0.5">
          {new Date().toLocaleDateString("ko-KR", { timeZone: APP_TIMEZONE, year: "numeric", month: "long", day: "numeric", weekday: "short" })}
        </p>
      </div>

      <div className="p-5 space-y-4">
        <div>
          <label className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2 block">
            마감시재 (돈통)
          </label>
          <NumberInput value={amount} onChange={setAmount} placeholder="0" autoFocus />
        </div>

        <div>
          <label className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2 block">
            마감자
          </label>
          <input
            type="text"
            value={workerName}
            onChange={e => setWorkerName(e.target.value)}
            onKeyDown={e => e.key === "Enter" && handleSettle()}
            placeholder="이름 입력"
            className="w-full px-4 py-2.5 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-orange-400"
          />
        </div>
      </div>

      <div className="flex gap-2 p-5 border-t border-gray-100">
        <button onClick={onClose} disabled={saving}
          className="flex-1 py-2.5 border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50 text-sm">
          취소
        </button>
        <button onClick={handleSettle} disabled={saving || !workerName.trim()}
          className="flex-1 py-2.5 bg-orange-500 text-white rounded-lg hover:bg-orange-600 disabled:opacity-50 font-medium text-sm">
          {saving ? "정산 중..." : "확인 (정산)"}
        </button>
      </div>
    </Modal>
  );
}
