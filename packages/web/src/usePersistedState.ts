import { useEffect, useState } from "react";
import type React from "react";

/**
 * `useState` mirrored to localStorage under `key`. Reads once (falling back to
 * `initial` on absence, parse error, or a null payload — so a corrupt/tampered
 * "null" can't crash consumers doing `value[someKey]`), and writes on every
 * change.
 *
 * NOT for high-frequency state: the events grid persists column *sizing* on
 * resize-END only (a write per drag-frame is the bug it avoids), so it keeps its
 * own specialized persistence rather than using this hook.
 */
export function usePersistedState<T>(
  key: string,
  initial: T,
): [T, React.Dispatch<React.SetStateAction<T>>] {
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(key);
      if (raw == null) return initial;
      const parsed = JSON.parse(raw) as unknown;
      return parsed == null ? initial : (parsed as T);
    } catch {
      return initial;
    }
  });

  useEffect(() => {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      /* ignore quota/availability — state still works in-session */
    }
  }, [key, value]);

  return [value, setValue];
}
