-- ============================================================
-- 230: 계정과목 9분류 확장 (유동/비유동 구분 등) + 표준 계정과목 시딩
--
-- 작성: 2026-07-31
-- 배경: 지금까지 자산/부채/자본/수익/비용 5분류였는데, 한국 전산회계
--   관행(더존 등)에 가까운 9분류(유동자산/비유동자산/유동부채/비유동
--   부채/자본/매출/매출원가/판관비/영업외손익)로 확장 — 사장님 확정.
--   gubun 은 전표의 차변/대변 방향 계산엔 안 쓰임(그건 cash_line_items.
--   direction 기준) — 순수 분류/코드밴드/리포트용이라 이 변경이 기존
--   전표 생성 트리거를 건드리지 않음.
-- 코드밴드: 유동자산100/비유동자산200/유동부채300/비유동부채400/
--   자본500/매출600/매출원가700/판관비800/영업외손익900.
-- 표준 계정과목 시딩은 이름 중복(UNIQUE tenant_id+name)이면 건너뜀 —
--   이미 커스텀으로 만든 계정은 안 건드림, 몇 번을 눌러도 안전.
-- ============================================================

BEGIN;

-- ── 기존 5분류 → 9분류 백필 (CHECK 바꾸기 전에 먼저) ────────────────
ALTER TABLE accounts DROP CONSTRAINT IF EXISTS accounts_gubun_check;
UPDATE accounts SET gubun = CASE gubun
  WHEN '자산' THEN '유동자산'
  WHEN '부채' THEN '유동부채'
  WHEN '자본' THEN '자본'
  WHEN '수익' THEN '매출'
  WHEN '비용' THEN '판관비'
  ELSE gubun
END;
ALTER TABLE accounts ADD CONSTRAINT accounts_gubun_check
  CHECK (gubun IN ('유동자산', '비유동자산', '유동부채', '비유동부채', '자본', '매출', '매출원가', '판관비', '영업외손익'));

-- 시스템계정(보통예금/부가세대급금/부가세예수금) gubun 보정.
UPDATE accounts SET gubun = '유동자산' WHERE system_key IN ('cash', 'vat_input');
UPDATE accounts SET gubun = '유동부채' WHERE system_key = 'vat_output';

-- ── 코드밴드 재정의 (9분류) ─────────────────────────────────────────
CREATE OR REPLACE FUNCTION next_account_code(p_tenant_id UUID, p_gubun TEXT) RETURNS SMALLINT AS $$
DECLARE
  v_base SMALLINT := CASE p_gubun
    WHEN '유동자산' THEN 100 WHEN '비유동자산' THEN 200
    WHEN '유동부채' THEN 300 WHEN '비유동부채' THEN 400
    WHEN '자본' THEN 500
    WHEN '매출' THEN 600 WHEN '매출원가' THEN 700
    WHEN '판관비' THEN 800 WHEN '영업외손익' THEN 900
  END;
  v_max SMALLINT;
BEGIN
  SELECT COALESCE(MAX(code), v_base) INTO v_max FROM accounts
    WHERE tenant_id = p_tenant_id AND code >= v_base AND code < v_base + 100;
  RETURN GREATEST(v_max, v_base) + 1;
END;
$$ LANGUAGE plpgsql;

-- ── 시스템계정 생성 함수도 새 gubun 값으로 ──────────────────────────
CREATE OR REPLACE FUNCTION ensure_cash_account(p_tenant_id UUID) RETURNS UUID AS $$
DECLARE v_id UUID;
BEGIN
  SELECT id INTO v_id FROM accounts WHERE tenant_id = p_tenant_id AND system_key = 'cash';
  IF v_id IS NULL THEN
    INSERT INTO accounts (tenant_id, name, gubun, is_system, system_key, sort_order)
    VALUES (p_tenant_id, '보통예금', '유동자산', true, 'cash', -1)
    RETURNING id INTO v_id;
  END IF;
  RETURN v_id;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION ensure_vat_account(p_tenant_id UUID, p_direction TEXT) RETURNS UUID AS $$
DECLARE
  v_id UUID;
  v_key TEXT := CASE p_direction WHEN 'out' THEN 'vat_input' ELSE 'vat_output' END;
  v_name TEXT := CASE p_direction WHEN 'out' THEN '부가세대급금' ELSE '부가세예수금' END;
  v_gubun TEXT := CASE p_direction WHEN 'out' THEN '유동자산' ELSE '유동부채' END;
BEGIN
  SELECT id INTO v_id FROM accounts WHERE tenant_id = p_tenant_id AND system_key = v_key;
  IF v_id IS NULL THEN
    INSERT INTO accounts (tenant_id, name, gubun, is_system, system_key, sort_order)
    VALUES (p_tenant_id, v_name, v_gubun, true, v_key, -1)
    RETURNING id INTO v_id;
  END IF;
  RETURN v_id;
END;
$$ LANGUAGE plpgsql;

-- ── 표준 계정과목 시딩 — 세팅탭 "표준 계정과목 불러오기" 버튼이 호출 ──
CREATE OR REPLACE FUNCTION seed_standard_accounts(p_tenant_id UUID) RETURNS INT AS $$
DECLARE
  v_count INT := 0;
  v_row RECORD;
BEGIN
  FOR v_row IN SELECT * FROM (VALUES
    ('유동자산', '현금'), ('유동자산', '매출채권'), ('유동자산', '미수금'), ('유동자산', '선급금'), ('유동자산', '선급비용'), ('유동자산', '재고자산'),
    ('비유동자산', '비품'), ('비유동자산', '차량운반구'), ('비유동자산', '임차보증금'), ('비유동자산', '감가상각누계액'),
    ('유동부채', '매입채무'), ('유동부채', '미지급금'), ('유동부채', '미지급비용'), ('유동부채', '예수금'), ('유동부채', '단기차입금'),
    ('비유동부채', '장기차입금'), ('비유동부채', '퇴직급여충당부채'),
    ('자본', '자본금'), ('자본', '이익잉여금'), ('자본', '인출금'),
    ('매출', '상품매출'), ('매출', '제품매출'), ('매출', '용역매출'),
    ('매출원가', '상품매출원가'), ('매출원가', '원재료비'),
    ('판관비', '급여'), ('판관비', '복리후생비'), ('판관비', '여비교통비'), ('판관비', '접대비'), ('판관비', '통신비'),
    ('판관비', '수도광열비'), ('판관비', '세금과공과'), ('판관비', '감가상각비'), ('판관비', '임차료'), ('판관비', '보험료'),
    ('판관비', '차량유지비'), ('판관비', '소모품비'), ('판관비', '지급수수료'), ('판관비', '광고선전비'), ('판관비', '도서인쇄비'), ('판관비', '교육훈련비'),
    ('영업외손익', '이자수익'), ('영업외손익', '이자비용'), ('영업외손익', '잡이익'), ('영업외손익', '잡손실')
  ) AS t(gubun, name)
  LOOP
    INSERT INTO accounts (tenant_id, name, gubun)
    VALUES (p_tenant_id, v_row.name, v_row.gubun)
    ON CONFLICT (tenant_id, name) DO NOTHING;
    IF FOUND THEN v_count := v_count + 1; END IF;
  END LOOP;
  RETURN v_count;
END;
$$ LANGUAGE plpgsql;

DO $$ BEGIN
  RAISE NOTICE '[230] 계정과목 9분류 확장 + 표준 계정과목 시딩 함수(seed_standard_accounts) 반영.';
END $$;

COMMIT;
