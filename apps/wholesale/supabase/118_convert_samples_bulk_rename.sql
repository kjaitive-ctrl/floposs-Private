-- ============================================================
-- 118: PostgREST schema cache 우회 — 함수명 변경
--
-- 증상:
--   117 (JSONB 시그니처) 등록 확인됐으나 PostgREST 가
--   schema cache 에서 process_sample_convert_batch 를 끝까지 못 잡음.
--   NOTIFY pgrst 'reload schema' 가 환경에서 작동 안 함.
--
-- 원인:
--   Supabase 의 PostgREST cache 가 특정 함수에 stale 한 채 잠긴 케이스.
--   같은 이름으로는 cache 갱신 안 됨.
--
-- 처방:
--   완전히 새로운 이름 convert_samples_bulk 로 함수 등록.
--   PostgREST 가 새 이름은 cache 미존재 → 즉시 새로 잡음.
--   기존 process_sample_convert_batch (JSONB) 도 호환 위해 그대로 둠.
-- ============================================================

CREATE OR REPLACE FUNCTION convert_samples_bulk(
  p_order_item_ids JSONB,
  p_tenant_id      UUID
) RETURNS JSON LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_ids              UUID[];
  v_first            RECORD;
  v_item             RECORD;
  v_total            NUMERIC := 0;
  v_new_order_id     UUID;
  v_new_order_number TEXT;
  v_count            INT     := 0;
  v_id               UUID;
BEGIN
  IF p_order_item_ids IS NULL OR jsonb_array_length(p_order_item_ids) = 0 THEN
    RETURN json_build_object('success', false, 'error', '항목이 비어있습니다.');
  END IF;

  SELECT array_agg(value::TEXT::UUID) INTO v_ids
  FROM jsonb_array_elements_text(p_order_item_ids) AS value;

  SELECT
    oi.id, oi.is_sample, oi.sample_status,
    o.customer_id, o.customer_name, o.payment_method, o.order_number, o.order_type
  INTO v_first
  FROM order_items oi
  JOIN orders o ON o.id = oi.order_id
  WHERE oi.id = v_ids[1] AND o.tenant_id = p_tenant_id;

  IF NOT FOUND THEN
    RETURN json_build_object('success', false, 'error', '첫 항목을 찾을 수 없습니다.');
  END IF;

  FOR v_item IN
    SELECT oi.id, oi.is_sample, oi.sample_status, oi.quantity, oi.unit_price,
           o.customer_id
    FROM order_items oi
    JOIN orders o ON o.id = oi.order_id
    WHERE oi.id = ANY(v_ids) AND o.tenant_id = p_tenant_id
  LOOP
    IF NOT v_item.is_sample THEN
      RETURN json_build_object('success', false, 'error', '샘플이 아닌 항목 포함');
    END IF;
    IF v_item.sample_status <> 'pending' THEN
      RETURN json_build_object('success', false, 'error', '이미 처리된 샘플 포함');
    END IF;
    IF v_item.customer_id <> v_first.customer_id THEN
      RETURN json_build_object('success', false, 'error', '서로 다른 거래처 항목 혼합');
    END IF;
    v_total := v_total + (v_item.quantity * v_item.unit_price);
    v_count := v_count + 1;
  END LOOP;

  IF v_count <> array_length(v_ids, 1) THEN
    RETURN json_build_object('success', false, 'error', '일부 항목을 찾을 수 없습니다.');
  END IF;

  UPDATE order_items
  SET sample_status = 'converted',
      updated_at    = NOW()
  WHERE id = ANY(v_ids);

  v_new_order_number := v_first.order_number || '-S'
    || substr(replace(gen_random_uuid()::text, '-', ''), 1, 4);

  INSERT INTO orders (
    tenant_id, customer_id, customer_name, order_number, order_type,
    order_source, status, total_amount, vat_amount, paid_amount, outstanding_amount,
    payment_method, payment_status, memo
  ) VALUES (
    p_tenant_id, v_first.customer_id, v_first.customer_name, v_new_order_number,
    COALESCE(v_first.order_type, 'wholesale'),
    'sample_convert', 'shipped',
    v_total, 0, 0, v_total,
    v_first.payment_method, 'unpaid',
    '샘플 매입 전환 묶음 (' || v_count || '건)'
  )
  RETURNING id INTO v_new_order_id;

  FOREACH v_id IN ARRAY v_ids
  LOOP
    SELECT variant_id, quantity, unit_price
    INTO v_item
    FROM order_items WHERE id = v_id;

    INSERT INTO order_items (
      order_id, variant_id, quantity, original_quantity, remaining_qty,
      unit_price, total_price, status, process_type,
      shipped_qty, shipped_at, is_sample, is_exchange,
      sample_status, sample_due_date
    ) VALUES (
      v_new_order_id, v_item.variant_id, v_item.quantity, v_item.quantity, 0,
      v_item.unit_price, v_item.quantity * v_item.unit_price, 'shipped', 'ordered',
      v_item.quantity, NOW(), FALSE, FALSE,
      NULL, NULL
    );
  END LOOP;

  PERFORM refresh_order_revenue(v_new_order_id);

  RETURN json_build_object(
    'success', true,
    'new_order_id', v_new_order_id,
    'new_order_number', v_new_order_number,
    'amount', v_total,
    'count', v_count
  );
END;
$$;

GRANT EXECUTE ON FUNCTION convert_samples_bulk(JSONB, UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION convert_samples_bulk(JSONB, UUID) TO anon;

NOTIFY pgrst, 'reload schema';
