-- ============================================================
-- 037: slot_stores.store_name 트라이그램 유사검색 (오타 허용)
--
-- 작성: 2026-06-01
-- 배경: 공급사 자동완성/중복가드가 지금 ILIKE substring 이라 오타를 못 잡음
--   ("크래파스" 로 치면 "크레파스" 못 찾음). 1만명 스케일에서 오타·표기변형
--   매칭이 중복가드 정확도의 핵심 → pg_trgm 유사도 검색 추가.
--
-- RPC search_slot_stores(q, lim): substring(ILIKE) ∪ 유사도(%) 합집합을
--   유사도 내림차순으로. substring 일치는 0.9 로 가산해 상단 고정.
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
LANGUAGE sql STABLE AS $$
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
$$;

DO $$ BEGIN
  RAISE NOTICE '[037] pg_trgm + search_slot_stores RPC 생성 완료. 오타 허용 유사검색 ON.';
END $$;

COMMIT;
