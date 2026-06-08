@AGENTS.md

# Retail Site — 프로젝트 문서

## 역할 (2026-05-14 재정의)

**플로포스 멀티업종 SaaS 의 retail vertical.** 5축 가치사슬 (디자이너-도매-물류-소매-플랫폼) 중 소매 단계 사용자가 운영하는 dashboard. wholesale-pos 와 함께 한 사업의 **두 축**.

옛 정의 (Phase 2 별도 B2B 플랫폼) 는 **폐기**. retail-site = 본 서비스의 일부이지 Phase 2 가 아님.

## 전체 가치사슬에서의 위치

```
디자이너 → 도매(wholesale-pos /dashboard) → 물류 → 소매(retail-site /order, /dashboard) → 플랫폼
                                                     ↑ 본 프로젝트
```

- 5축 가치사슬 자세한 모델 = [멀티업종 SaaS](../../Users/Min/.claude/projects/c--coding/memory/project_value_chain_5axis.md) 메모리
- 5축 모두 단일 wholesale-pos 인스턴스 안에서 가입 (단일 /login) → tenants.tenant_type 분기

## v1~v5 진화 로드맵

| 단계 | 기능 | 상태 |
|---|---|---|
| **v1** | 외부 주문 포털 — wholesale tenant 검색 + 엑셀형 주문 폼 | 작업 시작 (2026-05-14) |
| v2 | 샘플 수령 / 촬영 / 등록 워크플로우 (status 기반) | 보류 |
| v3 | 도매 상품 ↔ 소매 상품 매핑 (retail-측 PK 방향) | 보류 |
| v4 | 양방향 주문 송수신 + 알림 | 보류 |
| v5 | 플랫폼(쇼핑몰) 연동 + 엑셀 export | 보류 |

v1 작업 = `app/order/*` 페이지 + `app/api/order-portal/*` API. 기존 페이지 (촬영시트/설정/대시보드 골격) 는 v2 시점 본격 작업.

## 개발 환경

- **Framework**: Next.js (App Router, TypeScript, Tailwind CSS)
- **Port**: 3001 (`npm run dev` → http://localhost:3001)
- **Database**: Supabase — **wholesale-pos 와 동일 인스턴스** (Seoul: `ooxqrfeccorimwdusouc`)
- **인증**: Supabase Auth — wholesale-pos 와 같은 project. retail 가입자는 dummy email (`{phone}@order-portal.local`) + 비밀번호(영문+숫자+특수문자 8자 이상). 신규 가입은 복잡 정책으로 검증, 로그인 검증은 완화(레거시 4자리 PIN 가입자 보호). 옛 A' 모델(4자리 PIN)에서 2026-06-08 전환.
- **로컬 경로**: `C:\coding\retail-site`
- **운영 도메인 계획**: `retail.floposs.com` (Vercel custom domain, `*.floposs.com` 서브도메인 cookie share 위해)

## DB 설계 원칙 (재정의)

- **단일 Supabase 인스턴스 공유** — wholesale-pos 와 같은 인스턴스. 옛 "별도 프로젝트 + Edge Function/Webhook" 모델 폐기.
- **단일 tenants/users 모델 (C-1)** — retail tenant 도 `tenants(tenant_type='retail')` 의 한 row. 옛 `retail_retailers / retail_users` 테이블은 마이그 175 에서 폐기 예정.
- **DB 마이그 통합 관리** — 모든 마이그 SQL 은 `wholesale-pos/supabase/` 에서 작성. retail-site/supabase/ 별도 마이그 없음.
- **RLS 비활성** (개발 단계) — wholesale-pos 와 정책 동일.
- **자세한 결정 사항**: [외부 주문 포털 메모리](../../Users/Min/.claude/projects/c--coding/memory/project_wholesale_pos_external_order_portal.md)

## UI/코드 원칙

- **자체 컴포넌트** — wholesale-pos 의 Modal/SaleForm 등 import 안 함. retail-site 안에서 자체 작성.
- **`src/common/styles.ts` 중앙 관리** — 모든 페이지가 import 해서 사용. 페이지별 분산 금지.
- **엑셀형 ProductGrid** — v1 외부 주문 포털의 핵심 UI 패턴 (행 = 상품/옵션/수량).

## 관련 메모리 (Claude 메모리 시스템)

작업 전 다음 메모리 참고:
- `project_wholesale_pos_external_order_portal` — v1 작업 상세
- `project_retail_site_status` — v1~v5 진화 로드맵
- `project_multi_vertical_saas` — 5축 가치사슬 + admin 3탭 + C-1/D-1
- `feedback_schema_already_aligned` — schema.sql 본설계 우선 원칙
- `feedback_retail_styles` — src/common/styles.ts 중앙관리
- `project_value_chain_5axis` — 5축 + D-α/D-β multi-role
