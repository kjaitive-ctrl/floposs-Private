-- ============================================================
-- 035: 슬롯 정의 테이블 (db구조 단일 소스) + slots 확장
--
-- 작성: 2026-06-01
-- 배경: admin StoresView 의 건물/층/wing/열 enum 이 하드코딩이라
--       db구조와 불일치 → 정의 테이블로 db화 (단일 소스).
--       신규/편집 dropdown = slot_buildings + slot_field_options 로드.
-- [[project_retail_slot_register_ui]]
--
-- seed: db구조.xlsx → import (건물 39개 + 옵션 30개: floor 12 / wing 4 / section 14).
--       section 라벨 = 전체/특/A(가)~G(사)/H~L, floor = B2/B1/1~10.
-- ============================================================

-- slots 확장: 카테고리(시장분류 낮/밤/신발/기타) + section 다글자 허용("전체"/"특")
ALTER TABLE slots ADD COLUMN IF NOT EXISTS category TEXT;
ALTER TABLE slots ALTER COLUMN section TYPE TEXT;

-- 건물명 → 카테고리 매칭 (건물명 사용자 등록 가능, 카테고리는 기존 중 선택)
CREATE TABLE IF NOT EXISTS slot_buildings (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name          TEXT NOT NULL UNIQUE,
  category      TEXT NOT NULL,
  user_addable  BOOLEAN NOT NULL DEFAULT true,
  sort          INT NOT NULL DEFAULT 0
);
ALTER TABLE slot_buildings DISABLE ROW LEVEL SECURITY;

-- 공통 enum (층/wing/열). 호(unit)는 자유입력이라 제외.
CREATE TABLE IF NOT EXISTS slot_field_options (
  id     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  field  TEXT NOT NULL,                -- 'floor' | 'wing' | 'section'
  value  TEXT NOT NULL,
  label  TEXT,
  sort   INT NOT NULL DEFAULT 0,
  UNIQUE (field, value)
);
ALTER TABLE slot_field_options DISABLE ROW LEVEL SECURITY;
