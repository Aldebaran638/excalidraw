import type { WidgetState } from "./types";

/** One transient state source per instance, shared by canvas and dialog. */
export class WidgetRuntimeState {
  private listeners = new Set<(state: WidgetState) => void>();
  private committed: WidgetState;
  constructor(public state: WidgetState) {
    this.committed = state;
  }
  acceptDocument(state: WidgetState) {
    if (state !== this.committed) {
      this.committed = state;
      this.set(state);
    }
  }
  set(state: WidgetState) {
    if (state === this.state) {
      return;
    }
    this.state = state;
    this.listeners.forEach((listener) => listener(state));
  }
  subscribe(listener: (state: WidgetState) => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}
