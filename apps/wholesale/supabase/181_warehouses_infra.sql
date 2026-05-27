-- ============================================================
-- 181: 창고 (warehouses) 인프라 박기 — 동작 영향 0, 미래 확장 위한 본설계
--
-- 작성: 2026-05-18
-- 사장 결정 (2026-05-18 회의):
--   1. 창고 여러개 운영 가능하게 본설계만 미리 박기 (실 사용 시점은 미정)
--   2. default warehouse 를 기본으로 두기 (기존 row + 신규 INSERT 모두 자동 채움)
--
-- 영향 매트릭스
--   - 기존 inventory row: warehouse_id = default 창고 UUID 일괄 채움 (NULL X)
--   - UNIQUE(tenant_id, variant_id) 그대로 (1 row 만 가능, 옛 동작 보존)
--   - 모든 RPC (deduct/restore_inventory) 영향 0 (warehouse_id 무시)
--   - 모든 UI 영향 0 (SELECT 응답에 warehouse_id 추가, 클라이언트 무시)
--   - 신규 tenant 가입: trigger 가 자동으로 default 창고 1개 생성
--   - 신규 inventory INSERT: trigger 가 warehouse_id NULL 이면 default 자동 fill
--
-- 진짜 사용 시점 (별 마이그, 본 작업 무관)
--   - UNIQUE 제약 변경: (tenant_id, variant_id) → (tenant_id, variant_id, warehouse_id)
--   - deduct/restore_inventory RPC 가 warehouse_id 받기 시작
--   - UI: 창고별 분리 표시 + "어느 창고에서 출고" 입력
--   - warehouses 관리 페이지 (admin 또는 dashboard)
--
-- 멱등 + BEGIN/COMMIT
-- ============================================================

BEGIN;

-- ─────────────────────────────────────────────────────────
-- 1. warehouses 테이블 신설
-- ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS warehouses (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  address     TEXT,
  is_default  BOOLEAN DEFAULT false,
  is_active   BOOLEAN DEFAULT true,
  created_at  TIMESTAMPTZ DEFAULT now(),
  UNIQUE(tenant_id, name)
);

CREATE INDEX IF NOT EXISTS idx_warehouses_tenant ON warehouses(tenant_id);

-- tenant 당 default 창고 1개만 보장 (partial unique index)
CREATE UNIQUE INDEX IF NOT EXISTS idx_warehouses_default_per_tenant
  ON warehouses(tenant_id) WHERE is_default = true;


-- ─────────────────────────────────────────────────────────
-- 2. inventory 에 warehouse_id 컬럼 추가
-- ─────────────────────────────────────────────────────────
-- ON DELETE SET NULL: 창고 삭제 시 재고 row 는 보존 (warehouse_id 만 NULL).
-- 운영상 default 창고 삭제 X (UI/admin 에서 막을 예정), 외 창고는 비활성/이전 후 삭제.
ALTER TABLE inventory
  ADD COLUMN IF NOT EXISTS warehouse_id UUID REFERENCES warehouses(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_inventory_warehouse ON inventory(warehouse_id);


-- ─────────────────────────────────────────────────────────
-- 3. 기존 tenant 마다 "기본 창고" 자동 생성 (1회 백필)
-- ─────────────────────────────────────────────────────────
INSERT INTO warehouses (tenant_id, name, is_default, is_active)
SELECT id, '기본 창고', true, true
FROM tenants
ON CONFLICT (tenant_id, name) DO NOTHING;


-- ─────────────────────────────────────────────────────────
-- 4. 기존 inventory row 의 warehouse_id 를 그 tenant 의 기본 창고로 일괄 UPDATE
-- ─────────────────────────────────────────────────────────
UPDATE inventory i
SET warehouse_id = w.id
FROM warehouses w
WHERE w.tenant_id = i.tenant_id
  AND w.is_default = true
  AND i.warehouse_id IS NULL;


-- ─────────────────────────────────────────────────────────
-- 5. trigger: 신규 tenant 가입 시 자동 기본 창고 생성
-- ─────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION tenants_create_default_warehouse()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO warehouses (tenant_id, name, is_default, is_active)
  VALUES (NEW.id, '기본 창고', true, true)
  ON CONFLICT (tenant_id, name) DO NOTHING;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS create_default_warehouse_on_tenant ON tenants;
CREATE TRIGGER create_default_warehouse_on_tenant
  AFTER INSERT ON tenants
  FOR EACH ROW EXECUTE FUNCTION tenants_create_default_warehouse();


-- ─────────────────────────────────────────────────────────
-- 6. trigger: inventory INSERT 시 warehouse_id NULL 이면 기본 창고로 자동 fill
-- ─────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION inventory_fill_default_warehouse()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.warehouse_id IS NULL THEN
    SELECT id INTO NEW.warehouse_id
    FROM warehouses
    WHERE tenant_id = NEW.tenant_id AND is_default = true
    LIMIT 1;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS fill_default_warehouse_on_inventory ON inventory;
CREATE TRIGGER fill_default_warehouse_on_inventory
  BEFORE INSERT ON inventory
  FOR EACH ROW EXECUTE FUNCTION inventory_fill_default_warehouse();


-- ─────────────────────────────────────────────────────────
-- 완료 메시지
-- ─────────────────────────────────────────────────────────
DO $$
DECLARE
  v_warehouses_count INT;
  v_inventory_filled INT;
  v_inventory_null   INT;
BEGIN
  SELECT COUNT(*) INTO v_warehouses_count FROM warehouses WHERE is_default = true;
  SELECT COUNT(*) INTO v_inventory_filled FROM inventory WHERE warehouse_id IS NOT NULL;
  SELECT COUNT(*) INTO v_inventory_null   FROM inventory WHERE warehouse_id IS NULL;
  RAISE NOTICE '[181] warehouses 인프라 박힘. 기본 창고 % 개 생성, inventory % row 채움 (NULL 잔여: %).',
    v_warehouses_count, v_inventory_filled, v_inventory_null;
END $$;

COMMIT;
