-- ============================================================
-- 096: toggle_vat_period_skip RPC 단순화
--
-- 버그:
--   094 RPC 가 (auth.jwt() ->> 'sub')::UUID 로 skipped_by 박제 시도.
--   - auth.jwt() 가 SECURITY DEFINER 컨텍스트에서 NULL 가능
--   - search_path 미설정으로 auth 스키마 미인식 가능
--   - sub UUID 가 public.users.id 와 매핑 안 됨 (095 에서 FK 풀었으나 캐스팅 자체가 silent 실패 가능)
--
-- 정책:
--   skipped_by 박제는 핵심 기능 아님 (감사용). 제거하고 RPC 단순화.
--   사장 부담 최소화: 누가 했는지 추적 X — 그 월 그 거래처 신고 안 한다는 결정만 박제.
--
-- 변경:
--   1. RPC 본문에서 v_user_id 변수/할당 제거
--   2. SET search_path = public, pg_temp 명시 (안전)
-- ============================================================

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
