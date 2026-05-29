-- 200_r2_storage_quota.sql
-- R2 이미지 용량 추적 + plan 별 한도 + 자동 캐시 갱신 + 한도 체크 RPC.
--
-- 설계 (사장 결정 2026-05-28):
--   - tenants 에 사용량 캐시 (r2_usage_bytes / r2_image_count / r2_usage_updated_at)
--   - subscription_plans 에 한도 (r2_storage_quota_mb) — 0 = 무제한
--   - product_images INSERT/UPDATE/DELETE 트리거로 캐시 자동 갱신
--   - 기존 데이터 backfill (마이그 199 이후 등록분 SUM)
--   - check_r2_quota RPC — sign route 에서 사전 체크
--
-- 관련: [[feedback_accounting_integrity]] 정합성 — 캐시와 실제 SUM 의 drift 없게 트리거 정공법.

-- ── 1) tenants 캐시 컬럼 ──
ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS r2_usage_bytes      BIGINT       NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS r2_image_count      INT          NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS r2_usage_updated_at TIMESTAMPTZ  DEFAULT now();

-- ── 2) plans 한도 컬럼 — MB 단위. 0 = 무제한 ──
-- Free Beta 기본 500MB. 사장이 admin/plans 에서 조정.
ALTER TABLE subscription_plans
  ADD COLUMN IF NOT EXISTS r2_storage_quota_mb INT NOT NULL DEFAULT 500;

-- ── 3) trigger 함수: product_images 변경 시 tenants 캐시 자동 갱신 ──
CREATE OR REPLACE FUNCTION sync_tenant_r2_usage() RETURNS TRIGGER AS $$
DECLARE
  v_tenant_id  UUID;
  v_delta_b    BIGINT := 0;
  v_delta_c    INT    := 0;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT tenant_id INTO v_tenant_id FROM products WHERE id = NEW.product_id;
    v_delta_b := COALESCE(NEW.file_size, 0);
    v_delta_c := 1;
  ELSIF TG_OP = 'DELETE' THEN
    SELECT tenant_id INTO v_tenant_id FROM products WHERE id = OLD.product_id;
    v_delta_b := -COALESCE(OLD.file_size, 0);
    v_delta_c := -1;
  ELSIF TG_OP = 'UPDATE' THEN
    -- file_size 변경만 처리. (product_id 이동은 발생 X 가정.)
    SELECT tenant_id INTO v_tenant_id FROM products WHERE id = NEW.product_id;
    v_delta_b := COALESCE(NEW.file_size, 0) - COALESCE(OLD.file_size, 0);
  END IF;

  IF v_tenant_id IS NOT NULL AND (v_delta_b <> 0 OR v_delta_c <> 0) THEN
    UPDATE tenants
      SET r2_usage_bytes      = GREATEST(0, r2_usage_bytes + v_delta_b),
          r2_image_count      = GREATEST(0, r2_image_count + v_delta_c),
          r2_usage_updated_at = now()
      WHERE id = v_tenant_id;
  END IF;

  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_sync_tenant_r2_usage ON product_images;
CREATE TRIGGER trg_sync_tenant_r2_usage
  AFTER INSERT OR UPDATE OR DELETE ON product_images
  FOR EACH ROW
  EXECUTE FUNCTION sync_tenant_r2_usage();

-- ── 4) 기존 데이터 backfill ──
-- 마이그 199 이후 등록된 product_images 가 있어도 캐시 0 인 상태 → 한번에 보정.
UPDATE tenants t
  SET r2_usage_bytes      = COALESCE(sub.total_bytes, 0),
      r2_image_count      = COALESCE(sub.total_count, 0),
      r2_usage_updated_at = now()
  FROM (
    SELECT p.tenant_id,
           SUM(COALESCE(pi.file_size, 0)) AS total_bytes,
           COUNT(*)::INT                  AS total_count
    FROM product_images pi
    JOIN products p ON p.id = pi.product_id
    GROUP BY p.tenant_id
  ) sub
  WHERE t.id = sub.tenant_id;

-- tenant 가 product_images 0건이면 위 UPDATE 가 skip — 명시 reset
UPDATE tenants t
  SET r2_usage_bytes = 0, r2_image_count = 0
  WHERE NOT EXISTS (
    SELECT 1 FROM product_images pi
    JOIN products p ON p.id = pi.product_id
    WHERE p.tenant_id = t.id
  );

-- ── 5) 한도 체크 RPC — sign route 에서 사전 호출 ──
-- 사용량 + 새 파일 size 합산 후 한도 초과 검사.
-- plan 없거나 quota_mb=0 → 무제한 통과.
CREATE OR REPLACE FUNCTION check_r2_quota(
  p_tenant_id    UUID,
  p_extra_bytes  BIGINT DEFAULT 0
) RETURNS JSONB AS $$
DECLARE
  v_usage        BIGINT;
  v_quota_mb     INT;
  v_quota_bytes  BIGINT;
BEGIN
  SELECT t.r2_usage_bytes, p.r2_storage_quota_mb
    INTO v_usage, v_quota_mb
    FROM tenants t
    LEFT JOIN subscription_plans p ON p.id = t.plan_id
    WHERE t.id = p_tenant_id;

  IF v_usage IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'tenant_not_found');
  END IF;

  -- plan 없거나 무제한
  IF v_quota_mb IS NULL OR v_quota_mb = 0 THEN
    RETURN jsonb_build_object(
      'ok', true,
      'usage_bytes', v_usage,
      'quota_bytes', 0,
      'unlimited', true
    );
  END IF;

  v_quota_bytes := v_quota_mb::BIGINT * 1024 * 1024;

  IF v_usage + p_extra_bytes > v_quota_bytes THEN
    RETURN jsonb_build_object(
      'ok', false,
      'reason', 'quota_exceeded',
      'usage_bytes', v_usage,
      'quota_bytes', v_quota_bytes,
      'remaining_bytes', GREATEST(0, v_quota_bytes - v_usage),
      'requested_bytes', p_extra_bytes
    );
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'usage_bytes', v_usage,
    'quota_bytes', v_quota_bytes,
    'remaining_bytes', v_quota_bytes - v_usage
  );
END;
$$ LANGUAGE plpgsql;
