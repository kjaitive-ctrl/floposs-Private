-- ============================================================
-- 240: 트렌드 보드 (trend_seasons / trend_items) — retail "트렌드" 탭
--
-- 작성: 2026-11-23
-- 배경: 시즌(24FW·25FW·26SS…)별 트렌드 키워드를 구글시트처럼 적어두는 화면.
--   열 = 시즌(사장이 추가), 열 아래 칸 = 키워드(자유 입력).
-- 결정:
--   - 시즌·키워드 모두 소프트삭제(deleted_at). [[feedback_soft_delete_persistent_rows]]
--   - 순서 = sort_order. RLS 비활성(다른 retail 표와 동일).
--   - 초기 데이터: 사장 시트(24FW~26FW) 그대로 (주)케이제이리테일(untyl) 매장에 채움.
-- ============================================================

BEGIN;

CREATE TABLE IF NOT EXISTS trend_seasons (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  label       TEXT NOT NULL DEFAULT '',
  sort_order  INT  NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at  TIMESTAMPTZ
);
ALTER TABLE trend_seasons DISABLE ROW LEVEL SECURITY;
CREATE INDEX IF NOT EXISTS idx_trend_seasons_tenant ON trend_seasons(tenant_id, deleted_at, sort_order);

CREATE TABLE IF NOT EXISTS trend_items (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  season_id   UUID NOT NULL REFERENCES trend_seasons(id) ON DELETE CASCADE,
  text        TEXT NOT NULL DEFAULT '',
  sort_order  INT  NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at  TIMESTAMPTZ
);
ALTER TABLE trend_items DISABLE ROW LEVEL SECURITY;
CREATE INDEX IF NOT EXISTS idx_trend_items_season ON trend_items(season_id, deleted_at, sort_order);
CREATE INDEX IF NOT EXISTS idx_trend_items_tenant ON trend_items(tenant_id);

-- 초기 데이터 (이미 시즌이 있으면 건너뜀 → 두 번 실행해도 중복 안 생김)
DO $$
DECLARE
  t   UUID := '936cf3d0-f135-4cae-9496-09c6f21cb2ca';  -- (주)케이제이리테일 (untyl)
  sid UUID;
  seasons TEXT[] := ARRAY['24FW','25FW','26SS','26SS-2','26FW'];
  i INT; j INT;
  lists JSONB := '{
    "24FW":   ["금장가디건","도트/카모/플라워 - 패턴","브라운","셔츠레이어드/시스루","레이어드스커트"],
    "25FW":   ["헨리넥","커브드pt","플레어pt","브라운","치마/스커트","레깅스(착시스타킹)","올리브","퍼플","반바지/니트바지","하이넥","다이마루 레이어드","레그워머,핸드워머","니트밴드(헤어밴드)","긴팔+반팔레이어드","배색레이어드"],
    "26SS":   ["스트레이트핏","플레어/커브드","스트라이프","펀칭","반오프숄더","디스트로이드진","후디","헨리넥","데미지니트"],
    "26SS-2": ["7부 티","카프리 팬츠","레이어드(나시)","하렘팬츠","딥브이넥니트/가디건","홀터넥나시","숏팬츠(주머니 또는 치마레이어드)","펀칭","청록/민트/옐로우/오렌지"],
    "26FW":   ["딥브이넥","하이넥","일체형상의","민트코어"]
  }'::jsonb;
  kw TEXT;
BEGIN
  IF EXISTS (SELECT 1 FROM trend_seasons WHERE tenant_id = t) THEN
    RAISE NOTICE '[240] 시즌이 이미 있어 초기 데이터 건너뜀';
  ELSE
    FOR i IN 1..array_length(seasons, 1) LOOP
      INSERT INTO trend_seasons (tenant_id, label, sort_order)
      VALUES (t, seasons[i], i * 10) RETURNING id INTO sid;
      j := 0;
      FOR kw IN SELECT jsonb_array_elements_text(lists -> seasons[i]) LOOP
        j := j + 1;
        INSERT INTO trend_items (tenant_id, season_id, text, sort_order) VALUES (t, sid, kw, j * 10);
      END LOOP;
    END LOOP;
    RAISE NOTICE '[240] 트렌드 보드 초기 데이터 5개 시즌 채움';
  END IF;
END $$;

COMMIT;
