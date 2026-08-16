-- 233: 상품 이미지 색상 라벨 텍스트 각인 지원.
-- stamp_label = 현재 이미지에 합성되어 있는 최종 텍스트 (예: "아이보리(ivory)"). null = 각인 안 됨.
-- 실제 텍스트 합성은 R2 오브젝트를 직접 덮어쓰는 방식 (product_images.url 은 안 바뀜) —
-- 재각인 시 항상 R2 의 <key>.orig 백업본에서 다시 합성하므로 이 컬럼은 UI 표시/prefill 용도.
alter table product_images add column if not exists stamp_label text;
