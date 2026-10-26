import { isPreviewReport } from "../data/appPreview";

import type { AppPreviewReport } from "../data/appPreview";

/** Scoped to a single active turn; unsolicited/late reports have no authority. */
export class AgentPreviews {
  private reports = new Map<string, AppPreviewReport>();
  private expected = new Set<string>();
  private waiters = new Map<string, (value: AppPreviewReport | null) => void>();
  private key(id: string, version: number) {
    return `${id}/${version}`;
  }
  expect(id: string, version: number) {
    this.expected.add(this.key(id, version));
  }
  report(id: string, version: number, value: unknown) {
    const key = this.key(id, version);
    if (!this.expected.has(key) || !isPreviewReport(value)) {
      return false;
    }
    this.reports.set(key, value);
    this.waiters.get(key)?.(value);
    return true;
  }
  async wait(id: string, version: number, signal: AbortSignal) {
    const key = this.key(id, version);
    if (this.reports.has(key)) {
      return this.reports.get(key)!;
    }
    signal.throwIfAborted();
    return new Promise<AppPreviewReport | null>((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
        this.waiters.delete(key);
      };
      const finish = (value: AppPreviewReport | null) => {
        cleanup();
        resolve(value);
      };
      const abort = () => {
        cleanup();
        reject(signal.reason);
      };
      const timer = setTimeout(() => finish(null), 6000);
      this.waiters.set(key, finish);
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) {
        abort();
      }
    });
  }
}
