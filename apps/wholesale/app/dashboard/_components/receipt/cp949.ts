// CP949 (Korean) 인코딩 — server-only.
// iconv-lite 사용. 클라이언트 번들에 들어가지 않도록 server 코드에서만 import.

import iconv from "iconv-lite";

export function encodeKr(text: string): Uint8Array {
  return new Uint8Array(iconv.encode(text, "cp949"));
}
