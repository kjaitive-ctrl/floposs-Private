"use client";

import { useEffect, useState } from "react";
import { supabase } from "./supabase";

// measurement_templates 의 (system 공통 + tenant) category distinct.
// SizeModal 의 카테고리 source 와 동일 → /samples /products 필터 옵션으로 사용.
// 사장이 SizeModal 에서 새 카테고리 박을 때마다 다음 mount 시 반영.
export function useCategoryOptions(tenantId: string | undefined) {
  const [options, setOptions] = useState<string[]>([]);

  useEffect(() => {
    if (!tenantId) return;
    (async () => {
      const { data } = await supabase
        .from("measurement_templates")
        .select("category")
        .or(`tenant_id.is.null,tenant_id.eq.${tenantId}`)
        .eq("is_active", true)
        .order("sort_order", { ascending: true });
      const seen = new Set<string>();
      const cats: string[] = [];
      for (const row of (data ?? []) as Array<{ category: string }>) {
        if (row.category && !seen.has(row.category)) {
          seen.add(row.category);
          cats.push(row.category);
        }
      }
      setOptions(cats);
    })();
  }, [tenantId]);

  return options;
}
