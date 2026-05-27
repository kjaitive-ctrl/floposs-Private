# 주문 처리방식 / 박제 원칙 — 재기획 (B안 채택)

관리자 결정 (2026-05-07): 영수증 박제 원칙 불변. supply / vat 를 **별개의 돈** 으로 ledger 분리.

---

## 절대 원칙

**P0. 영수증 박제 원칙은 불변** (재발행 시 동일, 사후 변경 X)
**P1. supply 와 vat 는 별개 ledger** — `transactions.vat_type IN ('supply','vat')` 행 분리 박제
**P2. customer.include_vat = 결제 시 vat 함께 입금 여부 토글일 뿐** (vat 적용 자체 X)

---

## 거래처 결제수단별 처리방식

### 1. 현금 (cash)
- **출고 = 즉시 결제완료** (모든 현금 받음 가정)
- 외상 변동 X
- 회계: supply 기준 (vat OFF default). saleform 에서 vat ON 강제 시 supply + vat 모두 즉시 받음.
- 반품: 현금 환불 보류 → **외상 (−)** 누적

### 2. 통장 (transfer)
- **출고 = 외상 처리** (입금 대기)
- 회계: **supply 기준 default** (vat OFF default). saleform vat ON 강제 시 with_vat
- 반품: **외상 (−)** 누적

### 3. 청구 (credit)
- **출고 = 외상 처리** (월청구 대기)
- 회계: **supply + vat (with_vat) default**. saleform vat OFF 강제 시 supply only
- 반품: **외상 (−)** 누적

---

## DB 구조 — 단일 `transactions` 테이블 + `vat_type` 컬럼

```sql
ALTER TABLE transactions
  ADD COLUMN vat_type TEXT NOT NULL DEFAULT 'supply'
  CHECK (vat_type IN ('supply', 'vat'));

-- 기존 vat_amount 컬럼 폐지 (행 분리로 대체)
```

### 거래 박제 패턴

| 거래 종류 | 박제 행 |
|---|---|
| 청구거래처 출고 (100K + vat 10K) | `(supply, shipment, +100K)` + `(vat, shipment, +10K)` 2행 |
| 통장거래처 출고 (100K, vat off) | `(supply, shipment, +100K)` 1행 |
| 통장거래처 출고 + vat ON 강제 | 위와 동일 2행 |
| 현금거래처 출고 (100K) | `(supply, shipment, +100K)` + `(supply, payment, -100K)` (즉시결제) |
| 현금 + vat ON 강제 | `(supply, shipment, +100K)` + `(vat, shipment, +10K)` + `(supply, payment, -100K)` + `(vat, payment, -10K)` |
| 청구 입금 (with_vat 110K 받음) | `(supply, payment, -100K)` + `(vat, payment, -10K)` |
| 통장 supply 입금 (100K 받음) | `(supply, payment, -100K)` |
| 반품 (모든 결제수단) | `(supply, return, -supply)` + `(vat, return, -vat)` (원영수증 vat 비례) |
| 매입금 충당 | `(supply, credit_apply, -)` + `(vat, credit_apply, -)` 분리 |

**부호 규약**:
- shipment: 외상 + (받을 돈 누적)
- payment / credit_apply: 외상 - (받았으니 차감)
- return / refund: 환불 (외상 - 또는 +)

### 외상 sync (132 trigger 단순화)

```sql
outstanding_balance = SUM(amount * sign) WHERE vat_type='supply'
outstanding_vat     = SUM(amount * sign) WHERE vat_type='vat'

sign = CASE
  WHEN source IN ('shipment','refund') THEN +1
  WHEN source IN ('return','payment','credit_apply','purchase') THEN -1
END
```

→ 분기 단순. 두 컬럼 독립 sync.

---

## 영수증 박제 (P0 불변)

`orders.receipt_*` 박제 컬럼 그대로 유지 (159 식):
- `receipt_supply_amount` — 영수증의 공급가
- `receipt_vat_amount` — 영수증의 부가세
- `receipt_total_amount` — supply + vat
- `receipt_vat_in_payment` — 영수증 표시 mode (true → 부가세 라인 표시 / false → 숨김)
- `receipt_prev_balance` — 박제 시점 외상 (with_vat or supply only — vat_in_payment 따라)
- `receipt_payment_amount` — 박제 시점 transactions(payment, credit_apply) 실제 합계
- `receipt_post_balance` — prev + total - payment_amount

vat_in_payment 결정:
- 일반 주문: `orders.vat_amount > 0` (saleform 박제값) — orders.vat_amount 는 등록 시점 박제용 의미 유지
- 또는 신규 컬럼 `orders.vat_in_payment BOOL` 명시 박제 (등록 시점 토글 박제)
- derived (반품/해제/미송출고 등): 원영수증 vat_in_payment 상속

---

## 부가세 정산 (현금주의 KST)

**vat 신고 = `transactions WHERE vat_type='vat' AND source IN ('payment','credit_apply')` 의 SUM**

판매 기준 부가세 (`vat_type='vat' AND source='shipment'`) 와 별개. 입금 기준만 신고.
청구거래처 외상에 vat 가 쌓여있다가 입금 시점에 vat 신고 대상 ledger 로 들어감.

---

## 마이그 작업 (161)

1. `transactions.vat_type` 컬럼 추가 (default 'supply')
2. 기존 `vat_amount > 0` 인 transactions 행 분리: 한 행 → supply 행 + vat 행 (amount 분리)
3. `vat_amount` 컬럼 폐지 (또는 deprecate)
4. sync trigger 단순화 (vat_type 별 SUM)
5. RPC 전면 재작성:
   - refresh_order_revenue
   - process_pending_ship
   - process_release_for_customer
   - process_return_derived
   - convert_samples_bulk
   - process_payment / process_refund (수동 입금)
   - issue_receipt_snapshot (P1 박제값 그대로, payment_amount transactions 합계 식 유지)
6. 일괄 재계산 (외상 supply / vat 분리)

---

## 코드 작업

- `SaleForm` — 결제수단별 즉시결제 분기 (현금 자동 process_payment, 통장/청구 외상 유지)
- `orders-test` — 처리 흐름 동일 + 영수증 list 의 [현금][통장] 별 결제 버튼 의미 명확화
- 입출금 페이지 — vat_type 분기 표시 (판매/취소 컬럼 = supply 행만, 부가세 컬럼 = vat 행만)
- 영수증 route — receipt_* 박제값 사용 그대로
- 영수증 template — vat_in_payment 분기 그대로
- 외상 UI — outstanding_balance / outstanding_vat 분리 표시 그대로

---

## 작업 순서

1. 161 마이그 작성 (vat_type + RPC 전면 + sync 단순화)
2. 데이터 reset SQL 준비
3. 코드 일괄 수정 (saleform / 입출금 / 영수증 / 외상)
4. 테스트 (현금 / 통장 vat off / 통장 vat on / 청구 vat on / 청구 vat off / 반품 / 매입금 충당)
