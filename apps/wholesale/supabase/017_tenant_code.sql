-- ============================================================
-- 017_tenant_code.sql
-- 1) tenants: tenant_code CHAR(6) UNIQUE 추가
-- 2) 기존 테넌트: 랜덤 대문자 6자리 발급
-- 3) orders: (tenant_id, order_number) UNIQUE 제약
-- ============================================================

ALTER TABLE tenants ADD COLUMN IF NOT EXISTS tenant_code CHAR(6) UNIQUE;

-- 랜덤 대문자 6자리 생성 함수
CREATE OR REPLACE FUNCTION generate_tenant_code() RETURNS CHAR(6) AS $$
DECLARE
  chars TEXT := 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  result TEXT := '';
  i INT;
BEGIN
  FOR i IN 1..6 LOOP
    result := result || SUBSTR(chars, FLOOR(RANDOM() * 26)::INT + 1, 1);
  END LOOP;
  RETURN result;
END;
$$ LANGUAGE plpgsql;

-- 기존 테넌트에 코드 발급 (중복 시 재시도)
DO $$
DECLARE
  t RECORD;
  code CHAR(6);
BEGIN
  FOR t IN SELECT id FROM tenants WHERE tenant_code IS NULL LOOP
    LOOP
      code := generate_tenant_code();
      BEGIN
        UPDATE tenants SET tenant_code = code WHERE id = t.id;
        EXIT;
      EXCEPTION WHEN unique_violation THEN
        -- 중복이면 재시도
      END;
    END LOOP;
  END LOOP;
END;
$$;

-- orders: 테넌트 내 판매번호 중복 방지
ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_tenant_order_number_unique;
ALTER TABLE orders ADD CONSTRAINT orders_tenant_order_number_unique UNIQUE (tenant_id, order_number);
