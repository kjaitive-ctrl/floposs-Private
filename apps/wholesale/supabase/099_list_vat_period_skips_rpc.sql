-- ============================================================
-- 099: list_vat_period_skips RPC — vat_period_skips SELECT 를 RPC 로 감쌈
--
-- 증상:
--   페이지에서 supabase.from("vat_period_skips").select() 가 빈 결과 반환.
--   SQL Editor 에서는 행이 보임 → 페이지(anon/authenticated)만 못 읽음.
--   원인 후보: PostgREST schema cache 미반영, RLS, GRANT 누락 등.
--
-- 처방:
--   SELECT 를 SECURITY DEFINER RPC 로 감싸 의존성 제거.
--   페이지는 list_vat_period_skips RPC 호출.
-- ============================================================

CREATE OR REPLACE FUNCTION public.list_vat_period_skips(
  p_tenant_id    UUID,
  p_period_month TEXT
)
RETURNS TABLE(customer_id UUID)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
BEGIN
  PERFORM assert_tenant_access(p_tenant_id);
  RETURN QUERY
    SELECT s.customer_id FROM vat_period_skips s
    WHERE s.tenant_id    = p_tenant_id
      AND s.period_month = p_period_month;
END;
$function$;

NOTIFY pgrst, 'reload schema';
