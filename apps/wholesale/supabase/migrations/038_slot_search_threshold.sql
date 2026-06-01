-- ============================================================
-- 038: 공급사 유사검색 임계값 완화 (한글 1글자 오타 대응)
--
-- 작성: 2026-06-01
-- 배경: 037 의 search_slot_stores 가 pg_trgm 기본 임계값(0.3)을 써서
--   한글 3글자 첫 글자 오타("등신사" vs "동신사", 유사도 ≈0.14)를 못 잡음.
--   → 함수 안에서 SET LOCAL pg_trgm.similarity_threshold = 0.1 로 낮춤.
--   노이즈는 유사도 내림차순 + LIMIT 으로 흡수 (좋은 매칭이 상단).
--
-- 자체완결(idempotent): 037 미적용 환경에서도 단독 적용 가능.
-- [[project_retail_slot_order_portal_v2]]
-- ============================================================

BEGIN;

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS idx_slot_stores_name_trgm
  ON slot_stores USING gin (store_name gin_trgm_ops);

CREATE OR REPLACE FUNCTION search_slot_stores(q text, lim int DEFAULT 12)
RETURNS TABLE (
  id uuid, store_name text, phone text, smartphone text,
  slot_id uuid, building text, floor smallint, wing text, section text, unit text, sim real
)
LANGUAGE plpgsql STABLE AS $$
BEGIN
  -- 트랜잭션 로컬로만 임계값 완화 (gin 인덱스 쓰는 % 연산자에 적용)
  PERFORM set_config('pg_trgm.similarity_threshold', '0.1', true);
  RETURN QUERY
    SELECT ss.id, ss.store_name, ss.phone, ss.smartphone,
           s.id, s.building, s.floor, s.wing, s.section, s.unit,
           GREATEST(
             similarity(ss.store_name, q),
             CASE WHEN ss.store_name ILIKE '%' || q || '%' THEN 0.9 ELSE 0 END
           )::real AS sim
    FROM slot_stores ss
    JOIN slots s ON s.id = ss.slot_id
    WHERE ss.is_hidden = false
      AND (ss.store_name ILIKE '%' || q || '%' OR ss.store_name % q)
    ORDER BY sim DESC, ss.store_name
    LIMIT lim;
END $$;

DO $$ BEGIN
  RAISE NOTICE '[038] search_slot_stores 임계값 0.1 로 완화. 한글 1글자 오타 매칭 ON.';
END $$;

COMMIT;
