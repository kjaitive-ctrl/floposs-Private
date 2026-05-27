-- ============================================================
-- 094: vat_period_skips — 거래처×월 단위 부가세 신고제외(말소) 결정
--
-- 배경 (부가세 회계 멘탈 모델 회의 결과):
--   부가세 발행/신고 결정은 "거래 시점"이 아니라 "매월초"에 결정됨.
--   거래처가 "이번 달은 세금계산서 안 끊을게요" 하면 사장이 그 월 그 거래처
--   부가세 발생분 전체를 신고 대상에서 빼야 함.
--
-- 정책:
--   transactions 박제값(vat_amount)은 진실 그대로 보존 — 거래는 실제 일어났음.
--   skip 결정은 별도 레이어 — "이 (거래처, 월)의 vat 은 신고 대상에서 제외".
--   결정 번복 가능 (DELETE 로 복구).
--   vat 환불 송금 행위 자체의 기록은 별개 (process_refund 사용).
--
-- /vat-settlement 페이지가 표시 시 LEFT JOIN vat_period_skips 로 skipped 여부 확인.
-- 영업정산(refresh_biz_session_stats)은 기간 단위가 달라(세션 vs 월) 영향 없음.
-- ============================================================

CREATE TABLE IF NOT EXISTS vat_period_skips (
  tenant_id     UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  customer_id   UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  period_month  TEXT NOT NULL,                          -- 'YYYY-MM'
  skipped_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  memo          TEXT,
  PRIMARY KEY (tenant_id, customer_id, period_month),
  CHECK (period_month ~ '^[0-9]{4}-(0[1-9]|1[0-2])$')
);

CREATE INDEX IF NOT EXISTS idx_vat_period_skips_tenant_month
  ON vat_period_skips(tenant_id, period_month);


-- ── RPC: 거래처×월 신고제외 토글 ─────────────────────────────
-- p_skip=TRUE  → INSERT (이미 있으면 memo 갱신)
-- p_skip=FALSE → DELETE (없으면 무시)
CREATE OR REPLACE FUNCTION public.toggle_vat_period_skip(
  p_tenant_id    UUID,
  p_customer_id  UUID,
  p_period_month TEXT,
  p_skip         BOOLEAN,
  p_memo         TEXT DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
BEGIN
  PERFORM assert_tenant_access(p_tenant_id);

  IF p_period_month !~ '^[0-9]{4}-(0[1-9]|1[0-2])$' THEN
    RAISE EXCEPTION '잘못된 period_month 형식: % (YYYY-MM 필요)', p_period_month;
  END IF;

  IF p_skip THEN
    INSERT INTO vat_period_skips (tenant_id, customer_id, period_month, memo)
    VALUES (p_tenant_id, p_customer_id, p_period_month, p_memo)
    ON CONFLICT (tenant_id, customer_id, period_month) DO UPDATE
      SET skipped_at = now(),
          memo       = COALESCE(EXCLUDED.memo, vat_period_skips.memo);
  ELSE
    DELETE FROM vat_period_skips
    WHERE tenant_id    = p_tenant_id
      AND customer_id  = p_customer_id
      AND period_month = p_period_month;
  END IF;
END;
$function$;
