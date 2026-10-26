/** Detect lack of progress, not a smaller tool quota. Different pages/queries
 * and actual edit attempts remain available within the normal 100 rounds. */
export class AgentReadProgress {
  private key = "";
  private repeats = 0;
  private nudged = false;
  get stalled() {
    return this.repeats >= 3;
  }
  takeNudge() {
    if (!this.stalled || this.nudged) {
      return false;
    }
    this.nudged = true;
    return true;
  }
  private signature(name: string, hash: string, args: Record<string, unknown>) {
    return JSON.stringify([
      name,
      hash,
      Object.keys(args)
        .sort()
        .map((key) => [key, args[key]]),
    ]);
  }
  blocked(name: string, hash: string, args: Record<string, unknown>) {
    return this.stalled && this.key === this.signature(name, hash, args);
  }
  record(name: string, hash: string, args: Record<string, unknown>) {
    const key = this.signature(name, hash, args);
    if (key !== this.key) {
      this.nudged = false;
    }
    this.repeats = key === this.key ? this.repeats + 1 : 1;
    this.key = key;
  }
  editing() {
    this.key = "";
    this.repeats = 0;
    this.nudged = false;
  }
}
