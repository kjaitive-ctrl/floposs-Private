-- 112: 영수증 양식 텍스트 오버라이드 + tenants 업태/종목
--
-- 사장이 직접 Supabase Studio 에서 실행.
--
-- 영수증/미발송/샘플 3 양식의 슬롯 텍스트 + 토글을 양식별로 저장.
-- 양식 자체(레이아웃)는 코드 박제. 텍스트만 오버라이드.
-- 업태/종목 = 사업자등록증 표기 항목, 영수증 헤더 사업자정보에 표시.

BEGIN;

ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS business_type TEXT,
  ADD COLUMN IF NOT EXISTS business_category TEXT,
  ADD COLUMN IF NOT EXISTS receipt_text_overrides JSONB DEFAULT '{}'::jsonb;

COMMENT ON COLUMN tenants.business_type IS '사업자등록증 업태 (예: 도매). 영수증 헤더 표시.';
COMMENT ON COLUMN tenants.business_category IS '사업자등록증 종목 (예: 의류). 영수증 헤더 표시.';
COMMENT ON COLUMN tenants.receipt_text_overrides IS
  '영수증 3양식(receipt/pending/sample) 슬롯 텍스트 오버라이드 + ON/OFF 토글 + 자유 문단. 빈 객체 = 모두 기본값.';

COMMIT;
