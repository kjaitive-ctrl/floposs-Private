-- ============================================================
-- 066: 샘플 출고 시 D-Day 자동 시작 (트리거)
--
-- 배경:
--   샘플은 출고되어야 거래처에 전달된 것 → 그때부터 보유/반납 카운팅 시작.
--   주문 등록 시점엔 sample_status=NULL, sample_due_date=NULL 로만 박힘.
--   출고 시점에 자동으로 sample_status='pending' + sample_due_date 설정.
--
-- 동작:
--   order_items.shipped_qty 가 증가하는 UPDATE 시,
--   is_sample=true 이고 sample_status=NULL 이면
--   sample_status='pending', sample_due_date=today + sample_period_days 설정.
--
-- 부분출고 경우:
--   처음 출고: 트리거 발동 → due_date 설정
--   잔여 라인 (별도 INSERT): is_sample=true, sample_status=NULL 로 시작 →
--     나중에 잔여 출고할 때 트리거가 또 설정 (각자 D-Day)
-- ============================================================

CREATE OR REPLACE FUNCTION fn_sample_shipment_mark()
RETURNS TRIGGER
LANGUAGE plpgsql AS $$
DECLARE
  v_period INT;
BEGIN
  IF NEW.is_sample
     AND NEW.shipped_qty > COALESCE(OLD.shipped_qty, 0)
     AND NEW.sample_status IS NULL
  THEN
    SELECT t.sample_period_days INTO v_period
    FROM orders o
    JOIN tenants t ON t.id = o.tenant_id
    WHERE o.id = NEW.order_id;

    NEW.sample_status   := 'pending';
    NEW.sample_due_date := CURRENT_DATE + COALESCE(v_period, 7);
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_sample_shipment_mark ON order_items;
CREATE TRIGGER trg_sample_shipment_mark
  BEFORE UPDATE OF shipped_qty ON order_items
  FOR EACH ROW
  EXECUTE FUNCTION fn_sample_shipment_mark();
