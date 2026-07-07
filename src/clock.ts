/**
 * Injectable clock — the ONE seam for all time-based decisions.
 * Replace `now()` in tests with `setNow(fn)` to drive schedules,
 * cutoffs, and expiry verifications deterministically.
 */

let _now: (() => Date) | undefined;

/** Returns the current Date (real or overridden). */
export function now(): Date {
  return _now ? _now() : new Date();
}

/** Returns the current Unix timestamp in milliseconds. */
export function nowMs(): number {
  return now().getTime();
}

/** Override the clock in tests. Pass `undefined` to reset to real time. */
export function setNow(fn: (() => Date) | undefined): void {
  _now = fn;
}