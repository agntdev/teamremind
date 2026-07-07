/**
 * Injectable clock — the single seam for time-based decisions.
 *
 * Every schedule, cutoff, "today", expiry, and late/on-time decision routes
 * through `now()` so tests can override it with `setClock(...)`. Never call
 * `new Date()` / `Date.now()` inline.
 */
let _now: () => Date = () => new Date();

/** The current time (overridable via setClock for tests). */
export function now(): Date {
  return _now();
}

/**
 * Override the clock for testing. Returns the previous clock function so
 * callers can restore it after the test.
 */
export function setClock(fn: () => Date): () => Date {
  const prev = _now;
  _now = fn;
  return prev;
}