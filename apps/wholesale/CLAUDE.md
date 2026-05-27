@AGENTS.md

# Wholesale POS - 프로젝트 문서

## 비즈니스 모델
- **SaaS 플랫폼** — 우리 회사가 운영, 도매업체에 계정 발급 후 월 구독료 수취
- **3계층 구조**:
  - 슈퍼관리자 (우리 회사) — 전체 업체 관리, 플랜/구독 관리
  - 업체관리자 (도매업체) — 직원/메뉴/권한 커스터마이징
  - 일반사용자 (도매업체 직원) — 업무 처리

## 전체 공급망 구조
```
[생산/공장]
    ↓
[도매업체] ← Phase 1: 내부 POS
    ↓
[소매 쇼핑몰] ← Phase 2: B2B 연동
    ↓
[물류/택배사] ← Phase 3: 배송 연동
    ↓
[최종 소비자]
```

## 개발 환경
- **Framework**: Next.js 15 (App Router, TypeScript, Tailwind CSS)
- **Database**: Supabase (PostgreSQL)
- **배포**: Vercel
- **코드 저장소**: GitHub (kjaitive-ctrl/wholesale-pos)
- **로컬 경로**: C:\coding\wholesale-pos

## Phase 1 — 도매업체 내부 POS
- 거래처(바이어) 관리
- 상품/재고 관리 (사이즈, 색상, 옵션별)
- 판매/주문 처리
- 외상/미수금 관리
- 입출금 관리
- 생산 관리
- 대량 오더 관리
- 매출 리포트/정산
- 영수증 출력 (QZ Tray 연동, ESC/POS 프로토콜)

## Phase 2 — B2B 연동 플랫폼
- 소매 쇼핑몰 계정 온보딩 (사업자 인증)
- 주문 송수신
- 미입고 주문 일정/입금 소통
- 양방향 알림/메시지
- 상품 매핑 테이블 (도매 SKU ↔ 소매 SKU/바코드)

## Phase 3 — 외부 시스템 연동
- ERP 연동 (SAP, 더존 등)
- 물류/택배사 연동 (CJ대한통운, 한진, 로젠 등)
- 송장 생성 및 배송처리 자동화
- 소매업체 물류시스템 연동
- REST API + Webhook (API Key 발급 방식)

## 핵심 설계 원칙
- **멀티테넌트**: 업체별 데이터 완전 격리
- **API-first**: 모든 기능을 API로 제공, 외부 연동 가능
- **반응형**: PC, 태블릿, 모바일 모두 지원
- **관리자 커스터마이징**: 메뉴/권한/필드명 설정 가능
- **알림**: 카톡 복사 (이미지 클립보드 → 사용자가 직접 카톡 붙여넣기). 자동 발송 X (카카오 비즈니스 협업 X).
- **구독/결제**: 플랜별 기능 제한

## 현재 진행 상황

### 환경 셋업
- [x] GitHub 계정 생성 (kjaitive-ctrl)
- [x] Supabase 프로젝트 생성
- [x] Vercel 가입 및 배포 완료
- [x] Node.js v24.15.0 설치
- [x] Next.js 프로젝트 생성 및 GitHub 연동

### DB 스키마 (supabase/schema.sql 기준 — 마이그레이션 파일은 supabase/migrations/, supabase/0XX_*.sql)
- [x] SaaS 기반: subscription_plans, tenants, users, roles, permissions
- [x] 도매↔소매 연결: tenant_connections, product_mappings (외부 SKU 매핑)
- [x] 상품: products, product_images, product_variants, product_measurements, product_categories, product_customer_prices
- [x] 거래처: customers (신용한도, 외상잔액, VAT 모드 포함)
- [x] 재고: inventory, inbound_orders, inbound_items, inbound_item_logs
- [x] 주문/판매: orders (도매/벌크/B2B 구분), order_items (선출/예약/샘플/교환)
- [x] 영업 세션: biz_sessions (영업개시~영업정산 1단위, 한 tenant 동시 1세션)
- [x] 입출금: transactions (VAT 모드, 부가세 정산)
  - `biz_session_id` NOT NULL — 영업개시 후에만 INSERT 가능
  - 트리거 `fill_biz_session_id` (071)가 NULL이면 활성 세션으로 자동 채움
  - → RPC들은 biz_session_id를 명시 안 해도 됨
- [x] 부가세 배치: vat_batches, vat_batch_items
- [x] 생산: production_orders, production_items
- [x] 배송: shipments
- [x] 기타: menu_configs, api_keys, notifications
- [x] 성능 최적화 인덱스, 출하 RPC, 원자적 잔액 조정, 반품/교환 처리

### UI 구현 (app/ 기준)
- [x] 로그인 페이지 (app/login)
- [x] 슈퍼관리자: 업체 계정 관리(admin/accounts), 플랜 관리(admin/plans)
- [x] 대시보드 메인 (app/dashboard) + KPI/즐겨찾기
- [x] 거래처 관리 (dashboard/customers + CustomerModal)
- [x] 상품 관리 (dashboard/products + ProductModal)
- [x] 재고 관리 (dashboard/inventory)
- [x] 주문 관리 (dashboard/orders, /orders/new, /orders/[id]) + SaleForm
- [x] 입출금 (dashboard/transactions + ManualTransactionModal)
- [x] 영업정산 (dashboard/sales-settlement + BusinessSettleModal)
- [x] 영업개시 모달 (BizSessionOpenModal) + 가드 (lib/bizSession.ts ensureBizOpen)
- [x] 설정 페이지 (dashboard/settings)
- [x] 공통 컴포넌트: Modal, DataTable, SearchBox, SearchFilterBar, TabNavigation, ToggleSwitch

### 미완료
- [ ] 영수증 출력 (QZ Tray 연동, ESC/POS)
- [ ] Phase 2 본격 구현 (소매 온보딩, 양방향 주문 송수신, 알림/메시지)
- [ ] Phase 3 외부 연동 (ERP, 택배사, Webhook)
- [ ] RLS 활성화 (개발 중 비활성)
- [ ] 모바일 반응형 점검

### retail-site (별도 리포: c:\coding\retail-site)
- 같은 Supabase 인스턴스에 retail_ 접두어 테이블로 공존
- 마이그레이션: supabase/retail_001~004b_*.sql
