/* Opt-in test-process clock for hosts whose wall clock jumps (e.g. WSL resume).
 * Vitest 3 captures Date.now for its completion-time timeout check; a 250ms
 * test can otherwise falsely fail a 30s deadline. Native timeout guards remain
 * enabled. Never import this module in the application or change the OS clock.
 * Use NODE_OPTIONS=--require=./scripts/test-monotonic-clock.cjs so Vitest's
 * worker processes inherit it (Vitest filters most parent execArgv flags).
 */
const epoch = Date.now();
const readMonotonic = process.hrtime.bigint;
const started = readMonotonic();
Object.defineProperty(Date, "now", {
  configurable: true,
  writable: true,
  value: () => epoch + Number((readMonotonic() - started) / 1000000n),
});
