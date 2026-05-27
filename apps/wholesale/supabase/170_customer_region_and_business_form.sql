-- ============================================================
-- 170: customers 에 region (지역) + business_form (형태) 컬럼 추가
--
-- 관리자 요청 (2026-05-11):
--   거래처 검색 드롭다운에 지역 / 결제수단 / 형태 표시.
--   CustomerModal 에 형태 토글 (온라인/오프라인/기타) 추가.
--
-- 신설 컬럼:
--   region        TEXT — 자유 입력 (예: "서울 강남구"). NULL 허용.
--   business_form TEXT — 'online' | 'offline' | 'etc'. NULL 허용.
-- ============================================================

BEGIN;

ALTER TABLE customers
  ADD COLUMN IF NOT EXISTS region        TEXT,
  ADD COLUMN IF NOT EXISTS business_form TEXT;

ALTER TABLE customers
  ADD CONSTRAINT customers_business_form_check
  CHECK (business_form IS NULL OR business_form IN ('online', 'offline', 'etc'));

NOTIFY pgrst, 'reload schema';

COMMIT;
