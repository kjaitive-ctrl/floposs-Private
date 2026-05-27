-- 101: tenants 은행정보(메인/서브) + 매장위치(건물/층호수/매장명) 추가
--      customers 사입자(사입사명/사입자번호) 추가
--
-- 운영 적용 안전: 모두 NULLable, 기본값 X. 기존 row 영향 0.

-- ── tenants: 입금받을 은행계좌 정보 ──────────────────────────────────────
-- 메인 / 서브 2개. retail tenant 가 도매에게 입금할 때 안내용.
ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS main_bank_name    TEXT,
  ADD COLUMN IF NOT EXISTS main_bank_account TEXT,
  ADD COLUMN IF NOT EXISTS main_bank_holder  TEXT,
  ADD COLUMN IF NOT EXISTS sub_bank_name     TEXT,
  ADD COLUMN IF NOT EXISTS sub_bank_account  TEXT,
  ADD COLUMN IF NOT EXISTS sub_bank_holder   TEXT;

-- ── tenants: 매장 위치 구조화 (건물/층호수/매장명) ──────────────────────
-- 예: 디오트 / 3층 E열 37호 / 디홀릭
ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS store_building   TEXT,
  ADD COLUMN IF NOT EXISTS store_floor_unit TEXT,
  ADD COLUMN IF NOT EXISTS store_name       TEXT;

-- ── customers: 사입자 정보 ────────────────────────────────────────────
-- 사입자 = 거래처에서 실제 물건 사입하는 사람 (전화번호로 식별)
ALTER TABLE customers
  ADD COLUMN IF NOT EXISTS buyer_name  TEXT,
  ADD COLUMN IF NOT EXISTS buyer_phone TEXT;
