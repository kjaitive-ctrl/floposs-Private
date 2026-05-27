-- ============================================================
-- 083: JWT 기반 cross-tenant 접근 차단 helper 도입
--
-- 배경:
--   현재 모든 tenant-scoped 테이블은 RLS 비활성 (개발 정책).
--   모든 SECURITY DEFINER RPC 가 p_tenant_id 인자를 그대로 신뢰함.
--   → anon key + curl 로 다른 tenant 의 p_tenant_id 보내면 우회 가능.
--
-- 정책:
--   각 RPC 첫 줄에서 PERFORM assert_tenant_access(p_tenant_id) 호출.
--   JWT app_metadata.tenant_id 와 인자가 다르면 거부.
--   super_admin 은 모든 tenant 접근 허용 (admin 콘솔 동작 유지).
--
-- 다음 단계 (084):
--   박제된 RPC 들을 CREATE OR REPLACE 하면서 가드 한 줄 추가.
--
-- 운영 DB only RPC (deduct_inventory 5인자, process_payment,
-- process_status, apply_purchase_credit, process_refund) 는 본문 dump
-- 후 별도 박제 + 가드 적용 필요.
-- ============================================================

-- ── tenant_id 인자 받는 RPC 용 ────────────────────────────────
CREATE OR REPLACE FUNCTION assert_tenant_access(p_tenant_id UUID)
RETURNS VOID
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, auth, pg_temp
AS $$
DECLARE
  v_jwt    JSONB := COALESCE(auth.jwt(), '{}'::jsonb);
  v_role   TEXT  := v_jwt->'app_metadata'->>'role';
  v_tenant UUID  := NULLIF(v_jwt->'app_metadata'->>'tenant_id', '')::UUID;
BEGIN
  IF v_role = 'super_admin' THEN
    RETURN;
  END IF;

  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'unauthorized: missing tenant in token'
      USING ERRCODE = '42501';
  END IF;

  IF p_tenant_id IS NULL OR v_tenant <> p_tenant_id THEN
    RAISE EXCEPTION 'cross-tenant access denied'
      USING ERRCODE = '42501';
  END IF;
END;
$$;

-- ── order_id 만 받는 RPC (refresh_order_revenue 등) 용 ────────
CREATE OR REPLACE FUNCTION assert_order_tenant_access(p_order_id UUID)
RETURNS VOID
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, auth, pg_temp
AS $$
DECLARE
  v_tenant UUID;
BEGIN
  SELECT tenant_id INTO v_tenant FROM orders WHERE id = p_order_id;
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'order not found' USING ERRCODE = '42501';
  END IF;
  PERFORM assert_tenant_access(v_tenant);
END;
$$;

-- ── biz_session_id 만 받는 RPC (refresh_biz_session_stats 등) 용 ──
CREATE OR REPLACE FUNCTION assert_biz_session_tenant_access(p_biz_session_id UUID)
RETURNS VOID
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, auth, pg_temp
AS $$
DECLARE
  v_tenant UUID;
BEGIN
  SELECT tenant_id INTO v_tenant FROM biz_sessions WHERE id = p_biz_session_id;
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'biz_session not found' USING ERRCODE = '42501';
  END IF;
  PERFORM assert_tenant_access(v_tenant);
END;
$$;
