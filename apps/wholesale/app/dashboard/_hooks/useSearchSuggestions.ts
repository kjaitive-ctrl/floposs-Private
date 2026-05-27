"use client";

import { useRef, useState } from "react";
import type { Suggestion } from "../_components/SearchBox";

export function useSearchSuggestions(
  fetchFn: (q: string) => Promise<Suggestion[]>,
  delay = 200
): [Suggestion[], (q: string) => void] {
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  function handleQueryChange(q: string) {
    if (timerRef.current) clearTimeout(timerRef.current);
    if (!q.trim()) { setSuggestions([]); return; }
    timerRef.current = setTimeout(async () => {
      setSuggestions(await fetchFn(q));
    }, delay);
  }

  return [suggestions, handleQueryChange];
}
