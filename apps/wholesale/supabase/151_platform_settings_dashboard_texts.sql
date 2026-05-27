-- ============================================================
-- 151: platform_settings 에 dashboard_texts JSONB 컬럼 추가
--
-- 사장 대시보드 안의 안내문/가이드 멘트를 admin (super_admin) 이 편집 가능하게.
-- JSONB 한 컬럼에 모든 텍스트 키-값으로 저장 (확장성).
--
-- 첫 사용처: 매장 계정 운영 가이드 (StaffAccountsSection 의 ul 안 멘트들)
-- 키: 'staff_guide_items' = string[] (각 li 항목)
--
-- 비파괴: nullable JSONB. 기본값 '{}'. 기존 row 영향 0.
-- ============================================================

ALTER TABLE platform_settings
  ADD COLUMN IF NOT EXISTS dashboard_texts JSONB DEFAULT '{}'::JSONB;

-- 기본 가이드 멘트 시드 (처음 적용 시만 — 이미 값 있으면 보존)
UPDATE platform_settings
SET dashboard_texts = COALESCE(dashboard_texts, '{}'::JSONB)
                   || jsonb_build_object('staff_guide_items', jsonb_build_array(
                        '매장 PC 에 매장 계정으로 항상 로그인되어 있게 두세요.',
                        '사장님은 본인 디바이스(폰/노트북)에서 본인 계정으로 로그인해서 매출/정산을 봅니다.',
                        '직원이 퇴사하면 [비활성화] 버튼으로 즉시 로그인을 차단할 수 있습니다.',
                        '역할 = 직원/매니저. 현재 가시성은 동일 (사장 정책상 추후 메뉴별 차등 가능).'
                      ))
WHERE id = 1
  AND (dashboard_texts IS NULL OR NOT (dashboard_texts ? 'staff_guide_items'));

NOTIFY pgrst, 'reload schema';
