// Motion helpers shared by both apps. Every hook here reacts to a value the
// app already received from the service or from local verification. None of
// them starts motion on first render, so an animation never invents a change.

import { useEffect, useRef, useState } from "react";

/**
 * True for `ms` after `value` changes in a way `qualifies(prev, next)` accepts.
 * The first value seen never triggers.
 */
export function useFlash<T extends string | number | boolean | null>(
  value: T,
  qualifies: (prev: T, next: T) => boolean,
  ms = 1400,
): boolean {
  const prev = useRef<{ v: T } | null>(null);
  const timer = useRef<number | undefined>(undefined);
  const [on, setOn] = useState(false);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  useEffect(() => {
    const p = prev.current;
    prev.current = { v: value };
    if (p && p.v !== value && qualifies(p.v, value)) {
      setOn(true);
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setOn(false), ms);
    }
    // qualifies is a pure predicate; only the observed value drives this effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);
  return on;
}

/** Members that were not in the previous observed list, for `ms`. First list seen yields none. */
export function useNewlyAdded(list: readonly string[], ms = 1600): ReadonlySet<string> {
  const key = list.join("\u0000");
  const prev = useRef<Set<string> | null>(null);
  const timer = useRef<number | undefined>(undefined);
  const [added, setAdded] = useState<ReadonlySet<string>>(new Set());
  useEffect(() => () => window.clearTimeout(timer.current), []);
  useEffect(() => {
    const now = new Set(list);
    const before = prev.current;
    prev.current = now;
    if (!before) return;
    const fresh = [...now].filter((x) => !before.has(x));
    if (fresh.length === 0) return;
    setAdded(new Set(fresh));
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setAdded(new Set()), ms);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return added;
}

/**
 * The service clock, advanced locally between fetches: offset = server time
 * minus local time at the moment `serverIso` arrived. Display only; the
 * service alone decides expiry and lifecycle state.
 */
export function useServerClock(serverIso: string | null | undefined): number | null {
  const [offset, setOffset] = useState<number | null>(null);
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!serverIso) return;
    setOffset(Date.parse(serverIso) - Date.now());
  }, [serverIso]);
  useEffect(() => {
    const t = window.setInterval(() => setTick((x) => x + 1), 1000);
    return () => window.clearInterval(t);
  }, []);
  return offset === null ? null : Date.now() + offset;
}

/**
 * One composed entrance per page load: true from the first ready render until
 * `ms` later. It ends at once on the first pointer or key input, or when
 * `cancel` turns true (a sign-in in flight), so content that mounts after the
 * user acts is never held back by an entrance fade.
 */
export function useEntrance(ready: boolean, ms = 3200, cancel = false): boolean {
  const [done, setDone] = useState(false);
  useEffect(() => {
    if (done) return;
    const stop = () => setDone(true);
    window.addEventListener("pointerdown", stop, true);
    window.addEventListener("keydown", stop, true);
    return () => {
      window.removeEventListener("pointerdown", stop, true);
      window.removeEventListener("keydown", stop, true);
    };
  }, [done]);
  useEffect(() => {
    if (cancel && !done) setDone(true);
  }, [cancel, done]);
  useEffect(() => {
    if (!ready || done) return;
    const t = window.setTimeout(() => setDone(true), ms);
    return () => window.clearTimeout(t);
  }, [ready, done, ms]);
  return ready && !done && !cancel;
}

export function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}
