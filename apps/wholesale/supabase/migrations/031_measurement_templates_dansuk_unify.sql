-- ============================================================
-- 031: measurement_templates 단면 통일 + 팔통단면 추가
--
-- 작성: 2026-05-29
-- 사장 명시 (2026-05-29):
--   1. 모든 측정 용어는 "단면" 으로 통일 (둘레 = 한바퀴, 단면 = 측정 기준).
--   2. 사장 자체 커스텀 "팬츠" 카테고리가 옛 naming (허리둘레/엉덩이둘레/허벅지둘레/밑단너비) 으로
--      박혀있는 것을 단면 naming 으로 일괄 교체.
--   3. 소매 있는 카테고리 (상의/원피스/아우터 계열) 에 "팔통단면" 필드 추가.
--
-- 본 마이그
--   ① tenant 커스텀 templates 의 옛 둘레/너비 키 → 단면 naming UPDATE
--   ② 소매 있는 시드 카테고리 9개에 "팔통단면" append (이미 있으면 skip)
--   ③ product_measurements 박제 데이터의 옛 키 → 단면 rename (마이그 193 에서 일부 처리됐지만 안전망)
--
-- 영향 매트릭스
--   - admin/measurement-templates UI: 자동 반영 (field_keys 조회만).
--   - retail /products 사이즈 다운로드: 새 field_keys 기준으로 양식 생성.
--   - product_measurements 박제: 옛 키 잔존하면 단면으로 rename.
-- ============================================================

BEGIN;


-- ─────────────────────────────────────────────────────────
-- ① tenant 커스텀 templates field_keys 단면 통일
-- ─────────────────────────────────────────────────────────
-- 시스템 시드 (tenant_id IS NULL) 는 마이그 193 에서 단면 naming 으로 박혔으므로 변환 X.
-- tenant 자체 커스텀 (tenant_id 값) 만 변환.
UPDATE measurement_templates
SET field_keys = (
  SELECT jsonb_agg(
    CASE elem::text
      WHEN '"허리둘레"'   THEN '"허리단면"'::jsonb
      WHEN '"엉덩이둘레"' THEN '"힙단면"'::jsonb
      WHEN '"허벅지둘레"' THEN '"허벅지단면"'::jsonb
      WHEN '"밑단너비"'   THEN '"밑단단면"'::jsonb
      WHEN '"가슴둘레"'   THEN '"가슴단면"'::jsonb
      WHEN '"어깨너비"'   THEN '"어깨단면"'::jsonb
      ELSE elem
    END
  )
  FROM jsonb_array_elements(field_keys) AS elem
),
updated_at = now()
WHERE tenant_id IS NOT NULL
  AND field_keys ?| array['허리둘레','엉덩이둘레','허벅지둘레','밑단너비','가슴둘레','어깨너비'];


-- ─────────────────────────────────────────────────────────
-- ② 소매 있는 시드 카테고리에 "팔통단면" 추가
-- ─────────────────────────────────────────────────────────
-- 대상: 소매가 있는 상의/원피스/아우터 계열 9개.
-- 이미 팔통단면 있으면 skip.
UPDATE measurement_templates
SET field_keys = field_keys || '["팔통단면"]'::jsonb,
    updated_at = now()
WHERE tenant_id IS NULL
  AND category IN (
    '상의',
    '상의 / 셔츠',
    '상의 / 블라우스(셔츠)',
    '상의 / 티셔츠(목폴라)',
    '아우터',
    '아우터 / 가디건',
    '원피스',
    '원피스 / 반팔원피스',
    '원피스 / 목폴라원피스'
  )
  AND NOT (field_keys ? '팔통단면');


-- ─────────────────────────────────────────────────────────
-- ③ product_measurements 박제 키 단면 rename (안전망)
-- ─────────────────────────────────────────────────────────
-- 마이그 193 에서 대부분 처리됐지만, "팬츠" 자체 커스텀 카테고리에 박힌 옛 키는 그대로일 수 있음.
-- 카테고리 무관 일괄 rename (안전 — 단면 naming 으로 통일).
UPDATE product_measurements
SET measurements = (
  SELECT jsonb_object_agg(
    CASE key
      WHEN '허리둘레'   THEN '허리단면'
      WHEN '엉덩이둘레' THEN '힙단면'
      WHEN '허벅지둘레' THEN '허벅지단면'
      WHEN '밑단너비'   THEN '밑단단면'
      WHEN '가슴둘레'   THEN '가슴단면'
      WHEN '어깨너비'   THEN '어깨단면'
      ELSE key
    END,
    value
  )
  FROM jsonb_each(measurements)
)
WHERE measurements ?| array['허리둘레','엉덩이둘레','허벅지둘레','밑단너비','가슴둘레','어깨너비'];


-- ─────────────────────────────────────────────────────────
-- 완료 메시지
-- ─────────────────────────────────────────────────────────
DO $$
DECLARE
  v_custom_updated INT;
  v_seed_with_arm  INT;
  v_legacy_left    INT;
BEGIN
  -- ① tenant 커스텀 잔존 (변환 안 된)
  SELECT COUNT(*) INTO v_custom_updated FROM measurement_templates
    WHERE tenant_id IS NOT NULL
      AND field_keys ?| array['허리둘레','엉덩이둘레','허벅지둘레','밑단너비','가슴둘레','어깨너비'];

  -- ② 팔통단면 박힌 시드 (9 기대)
  SELECT COUNT(*) INTO v_seed_with_arm FROM measurement_templates
    WHERE tenant_id IS NULL AND field_keys ? '팔통단면';

  -- ③ product_measurements 옛 키 잔존
  SELECT COUNT(*) INTO v_legacy_left FROM product_measurements
    WHERE measurements ?| array['허리둘레','엉덩이둘레','허벅지둘레','밑단너비','가슴둘레','어깨너비'];

  RAISE NOTICE '[031] tenant 커스텀 옛 키 잔존: %개 (0 이어야 정상). 팔통단면 시드: %개 (9 기대). product_measurements 옛 키 잔존: %개 (0 이어야 정상).',
    v_custom_updated, v_seed_with_arm, v_legacy_left;
END $$;


COMMIT;
