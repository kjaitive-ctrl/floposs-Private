-- ============================================================
-- 110: 옵션(variant) 단위 세일 상태 추가
--
-- 사장 결정 (회의 2026-05-03):
--   "품절"/"세일"/"진행" 은 variant(옵션) 단위로 사장이 직접 토글.
--   재고 0 자동 품절이 아닌, *판매 중단 의사*.
--   product_variants.is_active 는 이미 존재 (DEFAULT true).
--   세일 상태는 현재 product 단위만 (products.is_sale) — 옵션 단위로 확장.
--
-- 정책:
--   variant.is_active=false → 품절 (노출 차단)
--   variant.is_active=true AND variant.is_sale=true → 세일 (노출 + 표시)
--   variant.is_active=true AND variant.is_sale=false → 진행 (정상)
--
-- 노출 차단 규칙: 신규 주문 폼(SaleForm) 등에서 is_active=false 옵션 검색/선택 불가.
--                기존 주문/처리 흐름엔 영향 X (이미 등록된 주문 보호).
-- ============================================================

ALTER TABLE product_variants
  ADD COLUMN IF NOT EXISTS is_sale BOOLEAN DEFAULT false;
