"use client";

import { useEffect, useState } from "react";
import { getTenantInfo, type TenantInfo } from "./tenant";

// 페이지 진입시 한번 fetch 해서 들고있는 hook.
// useTenant()   — 전체 정보 (id + tenantCode + companyName) 필요한 페이지용
// useTenantId() — id 만 필요한 페이지용 (대다수)

export function useTenant(): TenantInfo | null {
  const [info, setInfo] = useState<TenantInfo | null>(null);
  useEffect(() => {
    getTenantInfo().then(i => { if (i) setInfo(i); });
  }, []);
  return info;
}

export function useTenantId(): string | null {
  const info = useTenant();
  return info?.id ?? null;
}
