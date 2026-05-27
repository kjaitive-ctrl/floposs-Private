-- 거래처 테이블 필드 추가
ALTER TABLE customers
  ADD COLUMN IF NOT EXISTS business_name TEXT,           -- 사업자 상호명
  ADD COLUMN IF NOT EXISTS tax_email TEXT,               -- 세금계산서 발행 이메일
  ADD COLUMN IF NOT EXISTS contact1_name TEXT,           -- 담당자1 이름
  ADD COLUMN IF NOT EXISTS contact1_phone TEXT,          -- 담당자1 연락처
  ADD COLUMN IF NOT EXISTS contact1_role TEXT,           -- 담당자1 역할 (주문/물류 등)
  ADD COLUMN IF NOT EXISTS contact2_name TEXT,           -- 담당자2 이름
  ADD COLUMN IF NOT EXISTS contact2_phone TEXT,          -- 담당자2 연락처
  ADD COLUMN IF NOT EXISTS contact2_role TEXT,           -- 담당자2 역할
  ADD COLUMN IF NOT EXISTS include_vat BOOLEAN DEFAULT true;  -- 부가세 포함 여부
