-- ============================================================
-- 198: 바코드 시스템 (Code 128, 자체 발행)
--
-- 작성: 2026-05-28
-- 사장 결정 (2026-05-28 회의):
--   1. Code 128 / Product 18자리 / Variant 22자리 (product + dash + 3자리 seq)
--   2. 형식: FP{TENANT4}{YYYYMMDD8}{P_SEQ4}[-{V_SEQ3}]
--   3. 발급 시점 = "진행" (samples → products status='registered')
--   4. 폐기 시점 = "샘플로 회귀" (status='sample_received')
--      - DB barcode NULL 처리. 시퀀스는 영구 증가 (재사용 X).
--      - barcode_history 에 폐기 audit 박제.
--   5. tenant_no 4자리 자동 부여 (가입 순). 9999 초과 시 마이그로 확장.
--   6. 충돌: DB UNIQUE 제약 + atomic 시퀀스 → 수학적으로 불가능.
--   7. 외부 POS(편의점) 진열 시엔 GS1 EAN-13 별도. 본 시스템은 내부 + 카페24/SaaS 용.
-- ============================================================

BEGIN;


-- ─────────────────────────────────────────────────────────
-- ① tenants.barcode_tenant_no (4자리 자동 시퀀스)
-- ─────────────────────────────────────────────────────────
ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS barcode_tenant_no INT UNIQUE;

-- 기존 tenants 일괄 부여 (created_at 순)
WITH numbered AS (
  SELECT id, ROW_NUMBER() OVER (ORDER BY created_at) AS rn FROM tenants
)
UPDATE tenants t
  SET barcode_tenant_no = n.rn
  FROM numbered n
  WHERE t.id = n.id AND t.barcode_tenant_no IS NULL;

-- 신규 가입 trigger
CREATE OR REPLACE FUNCTION assign_tenant_barcode_no()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.barcode_tenant_no IS NULL THEN
    SELECT COALESCE(MAX(barcode_tenant_no), 0) + 1
      INTO NEW.barcode_tenant_no FROM tenants;
    IF NEW.barcode_tenant_no > 9999 THEN
      RAISE EXCEPTION 'barcode_tenant_no exceeded 9999. Migration needed to expand digits.';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_tenants_barcode_no ON tenants;
CREATE TRIGGER trg_tenants_barcode_no
  BEFORE INSERT ON tenants
  FOR EACH ROW EXECUTE FUNCTION assign_tenant_barcode_no();


-- ─────────────────────────────────────────────────────────
-- ② barcode 컬럼 추가 (nullable — 진행/샘플로 토글)
-- ─────────────────────────────────────────────────────────
ALTER TABLE products
  ADD COLUMN IF NOT EXISTS barcode TEXT UNIQUE;

ALTER TABLE product_variants
  ADD COLUMN IF NOT EXISTS barcode TEXT UNIQUE;

COMMENT ON COLUMN products.barcode IS
  '진행 시점에 발급된 바코드(18자리). 샘플로 회귀 시 NULL. 시퀀스는 영구 증가 (재사용 X).';
COMMENT ON COLUMN product_variants.barcode IS
  '진행 시점 발급 바코드(22자리 = product + "-" + 3자리). 샘플로 회귀 시 NULL.';


-- ─────────────────────────────────────────────────────────
-- ③ barcode_sequences (atomic 일별 시퀀스)
-- ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS barcode_sequences (
  tenant_no  INT NOT NULL,
  type       CHAR(1) NOT NULL CHECK (type IN ('P', 'V')),  -- P=Product daily, V=variant_per_product
  date_str   TEXT NOT NULL,                                  -- 'YYYYMMDD'
  last_seq   INT NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_no, type, date_str)
);

COMMENT ON TABLE barcode_sequences IS
  '바코드 atomic 시퀀스. tenant_no+type+date_str 조합당 last_seq 증가. P_SEQ=일별 / V_SEQ=product내별.';


-- ─────────────────────────────────────────────────────────
-- ④ barcode_history (영구 audit, 옛 바코드 추적)
-- ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS barcode_history (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id  UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  variant_id  UUID REFERENCES product_variants(id) ON DELETE CASCADE,
              -- NULL = 상품 바코드 / 값 = variant 바코드
  barcode     TEXT NOT NULL,
  issued_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at  TIMESTAMPTZ,                  -- NULL = 사용 중
  reason      TEXT                           -- '진행' / '샘플로 회귀' / '삭제' 등
);

CREATE INDEX IF NOT EXISTS idx_barcode_history_product ON barcode_history (product_id);
CREATE INDEX IF NOT EXISTS idx_barcode_history_barcode ON barcode_history (barcode);

ALTER TABLE barcode_sequences DISABLE ROW LEVEL SECURITY;
ALTER TABLE barcode_history DISABLE ROW LEVEL SECURITY;


-- ─────────────────────────────────────────────────────────
-- ⑤ Variant 바코드 발급 RPC (Product 바코드 + 일련번호)
-- ─────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION issue_variant_barcode(
  p_variant_id      UUID,
  p_product_barcode TEXT
) RETURNS TEXT AS $$
DECLARE
  v_product_id UUID;
  v_v_seq      INT;
  v_barcode    TEXT;
BEGIN
  SELECT product_id INTO v_product_id FROM product_variants WHERE id = p_variant_id;
  IF v_product_id IS NULL THEN
    RAISE EXCEPTION 'variant not found: %', p_variant_id;
  END IF;

  -- 현재 사용 중인 variant 바코드 count + 1 (이 product 안에서)
  SELECT COUNT(*) + 1 INTO v_v_seq
    FROM product_variants
    WHERE product_id = v_product_id
      AND barcode IS NOT NULL;

  IF v_v_seq > 999 THEN
    RAISE EXCEPTION 'V_SEQ exceeds 999 for product %. Need digit expansion.', v_product_id;
  END IF;

  v_barcode := format('%s-%s', p_product_barcode, lpad(v_v_seq::text, 3, '0'));

  UPDATE product_variants SET barcode = v_barcode WHERE id = p_variant_id;

  INSERT INTO barcode_history (product_id, variant_id, barcode, reason)
    VALUES (v_product_id, p_variant_id, v_barcode, '진행');

  RETURN v_barcode;
END;
$$ LANGUAGE plpgsql;


-- ─────────────────────────────────────────────────────────
-- ⑥ Product 바코드 발급 RPC (진행 시점)
--   → 자체 variants 들도 일괄 발급
-- ─────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION issue_product_barcode(p_product_id UUID)
RETURNS TEXT AS $$
DECLARE
  v_tenant_no INT;
  v_date_str  TEXT := to_char(now(), 'YYYYMMDD');
  v_p_seq     INT;
  v_barcode   TEXT;
  v_variant_id UUID;
BEGIN
  SELECT t.barcode_tenant_no INTO v_tenant_no
    FROM products p JOIN tenants t ON t.id = p.tenant_id
    WHERE p.id = p_product_id;

  IF v_tenant_no IS NULL THEN
    RAISE EXCEPTION 'tenant has no barcode_tenant_no for product %', p_product_id;
  END IF;

  -- 일별 시퀀스 atomic UPSERT
  INSERT INTO barcode_sequences (tenant_no, type, date_str, last_seq)
    VALUES (v_tenant_no, 'P', v_date_str, 1)
    ON CONFLICT (tenant_no, type, date_str)
      DO UPDATE SET last_seq = barcode_sequences.last_seq + 1
    RETURNING last_seq INTO v_p_seq;

  IF v_p_seq > 9999 THEN
    RAISE EXCEPTION 'P_SEQ exceeds 9999 for tenant_no=% date=%. Wait until next day or expand digits.',
      v_tenant_no, v_date_str;
  END IF;

  v_barcode := format('FP%s%s%s',
    lpad(v_tenant_no::text, 4, '0'),
    v_date_str,
    lpad(v_p_seq::text, 4, '0'));

  UPDATE products SET barcode = v_barcode WHERE id = p_product_id;

  INSERT INTO barcode_history (product_id, barcode, reason)
    VALUES (p_product_id, v_barcode, '진행');

  -- 활성 variant 들도 일괄 발급
  FOR v_variant_id IN
    SELECT id FROM product_variants
      WHERE product_id = p_product_id AND is_active = true
      ORDER BY created_at
  LOOP
    PERFORM issue_variant_barcode(v_variant_id, v_barcode);
  END LOOP;

  RETURN v_barcode;
END;
$$ LANGUAGE plpgsql;


-- ─────────────────────────────────────────────────────────
-- ⑦ 폐기 RPC (샘플로 회귀)
-- ─────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION revoke_product_barcode(
  p_product_id UUID,
  p_reason     TEXT DEFAULT '샘플로 회귀'
) RETURNS VOID AS $$
BEGIN
  -- 사용 중인 history rows 폐기 표시 (product + variant 모두)
  UPDATE barcode_history
    SET revoked_at = now(), reason = p_reason
    WHERE product_id = p_product_id AND revoked_at IS NULL;

  -- DB 컬럼 비움 (재발급 가능 상태로)
  UPDATE products SET barcode = NULL WHERE id = p_product_id;
  UPDATE product_variants SET barcode = NULL WHERE product_id = p_product_id;
END;
$$ LANGUAGE plpgsql;


COMMENT ON FUNCTION issue_product_barcode IS
  '진행 시점 호출. Product 18자리 + 활성 variants 22자리 일괄 발급. atomic 시퀀스, 재사용 X.';
COMMENT ON FUNCTION revoke_product_barcode IS
  '샘플로 회귀/삭제 시 호출. barcode NULL + history revoked_at 박제. 시퀀스는 그대로 (재사용 X).';


-- ─────────────────────────────────────────────────────────
-- 완료 메시지
-- ─────────────────────────────────────────────────────────
DO $$
DECLARE
  v_tenant_count INT;
BEGIN
  SELECT COUNT(*) INTO v_tenant_count FROM tenants WHERE barcode_tenant_no IS NOT NULL;
  RAISE NOTICE '[198] 바코드 시스템 박힘. tenant_no 부여 % 개.', v_tenant_count;
END $$;

COMMIT;
