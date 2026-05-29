-- 슬롯/매장 시스템 (2026-05-29 4차 합의)
-- [[project_retail_slot_register_ui]] [[project_retail_wholesale_matching_pending]]
-- 슬롯 = 건물-호수 PK (거의 불변). 매장은 슬롯에 박제되는 입주자 (N:1 이력).
-- retail tenant 는 슬롯을 자기 거래처로 매핑 (사적). admin (super_admin) 은 full CRUD.

-- slots: 슬롯 마스터 (공유, 모든 retail 이 read)
CREATE TABLE IF NOT EXISTS slots (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  building        TEXT NOT NULL,
  floor           SMALLINT NOT NULL,         -- B는 음수: B3=-3, B1=-1, 1=1, ..., 10=10
  wing            TEXT,                       -- enum: 신관/구관/별관/외곽/A동~D동 (NULL=없음)
  section         CHAR(1),                    -- A~N (NULL=없음)
  unit            TEXT NOT NULL,              -- 호수 (자유: 1, 01, 5-1, B, ...)
  normalized_key  TEXT NOT NULL UNIQUE,       -- building:floor:wing:section:unit
  is_physical     BOOLEAN NOT NULL DEFAULT true, -- 창고형/온라인 도매 = false
  created_by_tenant_id UUID REFERENCES tenants(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE slots DISABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS idx_slots_building_floor    ON slots(building, floor);
CREATE INDEX IF NOT EXISTS idx_slots_normalized_key    ON slots(normalized_key);

-- slot_stores: 슬롯-매장 N:1 이력 (공유)
-- retail 측은 append-only, admin 은 full CRUD (사장 명시 2026-05-29)
CREATE TABLE IF NOT EXISTS slot_stores (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slot_id         UUID NOT NULL REFERENCES slots(id) ON DELETE CASCADE,
  store_name      TEXT NOT NULL,
  phone           TEXT,                       -- 02/031/070
  smartphone      TEXT,                       -- 010
  store_order     INT NOT NULL,               -- 1부터, 박제 순서
  is_current      BOOLEAN NOT NULL DEFAULT false,
  is_hidden       BOOLEAN NOT NULL DEFAULT false,
  raw_phone       TEXT,                       -- 원본 (시드 import 시 보존)
  added_by_tenant_id UUID REFERENCES tenants(id) ON DELETE SET NULL,
  added_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE slot_stores DISABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS idx_slot_stores_slot        ON slot_stores(slot_id, store_order);
CREATE INDEX IF NOT EXISTS idx_slot_stores_current     ON slot_stores(slot_id) WHERE is_current;

-- retail_suppliers: retail 의 거래처 매핑 (사적)
-- retail_tenant_id 당 slot 1개 매핑 (UNIQUE). selected_store_id 는 매장 선택, alias 는 별명.
CREATE TABLE IF NOT EXISTS retail_suppliers (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  retail_tenant_id    UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  slot_id             UUID NOT NULL REFERENCES slots(id) ON DELETE RESTRICT,
  selected_store_id   UUID REFERENCES slot_stores(id) ON DELETE SET NULL,
  alias               TEXT,                   -- 사입용상호 (retail 별명)
  memo                TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (retail_tenant_id, slot_id)
);
ALTER TABLE retail_suppliers DISABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS idx_retail_suppliers_tenant ON retail_suppliers(retail_tenant_id);
