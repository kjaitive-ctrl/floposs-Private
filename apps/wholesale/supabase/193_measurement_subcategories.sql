-- ============================================================
-- 193: measurement_templates 세부 카테고리 + 단면 naming 통일 + required_keys
--
-- 작성: 2026-05-28
-- 사장 결정 (2026-05-28 회의):
--   1. 옛 평면 카테고리(상의/하의/원피스/아우터/스커트/민소매)는 fallback 으로 유지.
--      세부 카테고리 9개 신규 추가 — 사장이 모든 세부를 다 안 주셔서(필드셋 같은 건 생략)
--      커버되지 않는 세부는 평면 카테고리로 fallback.
--   2. 모든 카테고리 필드는 "단면" naming 으로 통일 (어깨단면/가슴단면/허리단면 등).
--   3. 평면 카테고리 = 적당한 기본 필드셋 (세부 중 가장 단순한 것 기준).
--   4. required_keys 신설 — "총장"을 모든 카테고리에서 필수로 표시.
--
-- 본 마이그 (마이그 192는 건너뜀 — 193이 superset):
--   ① measurement_templates.required_keys JSONB 컬럼 추가
--   ② 평면 카테고리 UPDATE (단면 naming + baseline 필드셋 + required=총장)
--   ③ 민소매(나시) UPSERT (192 건너뛰면 없음)
--   ④ 세부 9개 UPSERT (상의/아우터/원피스/하의 계열)
--   ⑤ product_measurements 옛 키 (어깨너비/가슴둘레/...) → 단면 naming 글로벌 rename
--
-- 영향 매트릭스
--   - retail SizeModal: required_keys 읽어서 * 표시 (별도 코드 변경).
--   - 옛 박제 데이터: 키 rename 후 새 컬럼에 그대로 노출.
--   - wholesale: 미사용 (영향 X).
-- ============================================================

BEGIN;


-- ─────────────────────────────────────────────────────────
-- ① required_keys 컬럼 추가
-- ─────────────────────────────────────────────────────────
ALTER TABLE measurement_templates
  ADD COLUMN IF NOT EXISTS required_keys JSONB NOT NULL DEFAULT '[]'::jsonb;

COMMENT ON COLUMN measurement_templates.required_keys IS
  '필수 필드 키 배열. SizeModal 컬럼 헤더에 * 빨간 마커. 향후 저장 가드용.';


-- ─────────────────────────────────────────────────────────
-- ② 평면 카테고리 — 단면 naming 통일 + baseline 필드셋
-- ─────────────────────────────────────────────────────────
-- 상의: 셔츠 수준의 4개 baseline
UPDATE measurement_templates
SET field_keys    = '["총장","어깨단면","가슴단면","소매길이"]'::jsonb,
    required_keys = '["총장"]'::jsonb,
    updated_at    = now()
WHERE tenant_id IS NULL AND category = '상의';

-- 하의: 팬츠 수준 6개
UPDATE measurement_templates
SET field_keys    = '["총장","허리단면","힙단면","허벅지단면","밑위길이","밑단단면"]'::jsonb,
    required_keys = '["총장"]'::jsonb,
    updated_at    = now()
WHERE tenant_id IS NULL AND category = '하의';

-- 원피스: 민소매원피스 수준 6개
UPDATE measurement_templates
SET field_keys    = '["총장","어깨단면","가슴단면","허리단면","암홀단면","밑단단면"]'::jsonb,
    required_keys = '["총장"]'::jsonb,
    updated_at    = now()
WHERE tenant_id IS NULL AND category = '원피스';

-- 아우터: 베스트 수준 5개
UPDATE measurement_templates
SET field_keys    = '["총장","어깨단면","가슴단면","암홀단면","밑단단면"]'::jsonb,
    required_keys = '["총장"]'::jsonb,
    updated_at    = now()
WHERE tenant_id IS NULL AND category = '아우터';

-- 스커트: 4개
UPDATE measurement_templates
SET field_keys    = '["총장","허리단면","힙단면","밑단단면"]'::jsonb,
    required_keys = '["총장"]'::jsonb,
    updated_at    = now()
WHERE tenant_id IS NULL AND category = '스커트';


-- ─────────────────────────────────────────────────────────
-- ③ 민소매(나시) UPSERT (192 건너뛰면 없음)
-- ─────────────────────────────────────────────────────────
INSERT INTO measurement_templates (tenant_id, category, field_keys, required_keys, sort_order)
VALUES (NULL, '민소매(나시)',
  '["총장","어깨단면","가슴단면","암홀단면","밑단단면"]'::jsonb,
  '["총장"]'::jsonb, 6)
ON CONFLICT (category) WHERE tenant_id IS NULL DO UPDATE
  SET field_keys    = EXCLUDED.field_keys,
      required_keys = EXCLUDED.required_keys,
      updated_at    = now();


-- ─────────────────────────────────────────────────────────
-- ④ 세부 카테고리 9개 UPSERT
-- ─────────────────────────────────────────────────────────
INSERT INTO measurement_templates (tenant_id, category, field_keys, required_keys, sort_order)
VALUES
  -- 상의 계열
  (NULL, '상의 / 셔츠',
    '["총장","어깨단면","소매길이","가슴단면"]'::jsonb,
    '["총장"]'::jsonb, 11),
  (NULL, '상의 / 블라우스(셔츠)',
    '["총장","어깨단면","가슴단면","허리단면","암홀단면","소매길이","소매단면","밑단단면"]'::jsonb,
    '["총장"]'::jsonb, 12),
  (NULL, '상의 / 티셔츠(목폴라)',
    '["총장","어깨단면","가슴단면","소매길이","소매단면","암홀단면","밑단단면","목높이"]'::jsonb,
    '["총장"]'::jsonb, 13),

  -- 아우터 계열
  (NULL, '아우터 / 베스트(패딩조끼)',
    '["총장","어깨단면","가슴단면","암홀단면","밑단단면"]'::jsonb,
    '["총장"]'::jsonb, 21),
  (NULL, '아우터 / 가디건',
    '["총장","어깨단면","가슴단면","소매길이","소매단면","암홀단면","밑단단면"]'::jsonb,
    '["총장"]'::jsonb, 22),

  -- 원피스 계열
  (NULL, '원피스 / 민소매원피스',
    '["총장","어깨단면","가슴단면","허리단면","암홀단면","밑단단면"]'::jsonb,
    '["총장"]'::jsonb, 31),
  (NULL, '원피스 / 반팔원피스',
    '["총장","어깨단면","가슴단면","허리단면","암홀단면","소매길이","소매단면","밑단단면"]'::jsonb,
    '["총장"]'::jsonb, 32),
  (NULL, '원피스 / 목폴라원피스',
    '["총장","어깨단면","가슴단면","허리단면","암홀단면","소매길이","소매단면","밑단단면","목높이"]'::jsonb,
    '["총장"]'::jsonb, 33),

  -- 하의 계열 (사장 이미지 그대로 "팬츠 / 점프수트")
  (NULL, '팬츠 / 점프수트',
    '["총장","허리단면","힙단면","밑위길이","허벅지단면","밑단단면","가슴단면"]'::jsonb,
    '["총장"]'::jsonb, 41)
ON CONFLICT (category) WHERE tenant_id IS NULL DO UPDATE
  SET field_keys    = EXCLUDED.field_keys,
      required_keys = EXCLUDED.required_keys,
      updated_at    = now();


-- ─────────────────────────────────────────────────────────
-- ⑤ product_measurements 옛 키 글로벌 rename → 단면 naming
-- ─────────────────────────────────────────────────────────
-- 두 가지 옛 상태를 모두 흡수:
--   (a) 184 원본 (어깨너비/가슴둘레/허리둘레/엉덩이둘레/허벅지둘레/밑단너비)
--   (b) 192 단축형 (어깨/가슴/허리/힙/허벅지/밑단/소매/암홀/밑위) — 192 가 이미 적용된 환경
-- → 모두 단면 naming 으로 통일 (어깨단면/가슴단면/.../소매길이/암홀단면/밑위길이).
-- 카테고리 무관 일괄 rename — 새 이름이 전 카테고리 동일.
-- 비고: 192 의 팔통단면/소매단면/기타1/기타2 는 그대로 둠 (193 일부 템플릿에 소매단면 존재).
UPDATE product_measurements
SET measurements = (
  SELECT jsonb_object_agg(
    CASE key
      -- 184 원본 키
      WHEN '어깨너비'   THEN '어깨단면'
      WHEN '가슴둘레'   THEN '가슴단면'
      WHEN '허리둘레'   THEN '허리단면'
      WHEN '엉덩이둘레' THEN '힙단면'
      WHEN '허벅지둘레' THEN '허벅지단면'
      WHEN '밑단너비'   THEN '밑단단면'
      -- 192 단축 키
      WHEN '어깨'       THEN '어깨단면'
      WHEN '가슴'       THEN '가슴단면'
      WHEN '허리'       THEN '허리단면'
      WHEN '힙'         THEN '힙단면'
      WHEN '허벅지'     THEN '허벅지단면'
      WHEN '밑단'       THEN '밑단단면'
      WHEN '소매'       THEN '소매길이'
      WHEN '암홀'       THEN '암홀단면'
      WHEN '밑위'       THEN '밑위길이'
      ELSE key
    END,
    value
  )
  FROM jsonb_each(measurements)
)
WHERE measurements ?| array[
  '어깨너비','가슴둘레','허리둘레','엉덩이둘레','허벅지둘레','밑단너비',
  '어깨','가슴','허리','힙','허벅지','밑단','소매','암홀','밑위'
];


-- ─────────────────────────────────────────────────────────
-- 완료 메시지
-- ─────────────────────────────────────────────────────────
DO $$
DECLARE
  v_template_count INT;
  v_required_count INT;
  v_legacy_left    INT;
BEGIN
  SELECT COUNT(*) INTO v_template_count FROM measurement_templates WHERE tenant_id IS NULL;
  SELECT COUNT(*) INTO v_required_count FROM measurement_templates
    WHERE tenant_id IS NULL AND jsonb_array_length(required_keys) > 0;
  SELECT COUNT(*) INTO v_legacy_left FROM product_measurements
    WHERE measurements ?| array[
      '어깨너비','가슴둘레','허리둘레','엉덩이둘레','허벅지둘레','밑단너비',
      '어깨','가슴','허리','힙','허벅지','밑단','소매','암홀','밑위'
    ];
  RAISE NOTICE '[193] 시스템 템플릿 % 개 (required 마커 %개). 옛 키 잔존 row % 개 (0 이어야 정상).',
    v_template_count, v_required_count, v_legacy_left;
END $$;

COMMIT;
