/** lib/hooks.ts — small UI hooks. */
import { useEffect, useRef, useState } from "react";

/** Re-renders every `intervalMs` and returns the current unix-seconds clock, so
 * time-based displays (countdowns, "ago") tick smoothly between backend polls. */
export function useClock(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const t = setInterval(() => setNow(Math.floor(Date.now() / 1000)), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}

/** Returns "up" | "down" | "" for one render whenever `value` changes, to flash. */
export function usePriceFlash(value: number): "up" | "down" | "" {
  const prev = useRef(value);
  const [dir, setDir] = useState<"up" | "down" | "">("");
  useEffect(() => {
    if (value > prev.current) setDir("up");
    else if (value < prev.current) setDir("down");
    prev.current = value;
    const t = setTimeout(() => setDir(""), 600);
    return () => clearTimeout(t);
  }, [value]);
  return dir;
}
