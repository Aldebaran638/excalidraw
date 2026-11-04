export const NORMAL_TOOL_ROUNDS = 100;
export const RECOVERY_TOOL_ROUNDS = 100;

/** Failed/replayed batches and automatic recovery have a separate allowance. */
export class ToolLoopBudget {
  normalRounds = 0;
  recoveryRounds = 0;

  assertAvailable() {
    if (this.normalRounds >= NORMAL_TOOL_ROUNDS) {
      throw new Error(
        `本轮已完成 ${NORMAL_TOOL_ROUNDS} 次正常工具往返，已有候选和草稿保留；可手动继续`,
      );
    }
    if (this.recoveryRounds >= RECOVERY_TOOL_ROUNDS) {
      throw new Error(
        `本轮失败重试／恢复已达 ${RECOVERY_TOOL_ROUNDS} 次，未占用正常工具轮次；已有候选和草稿保留`,
      );
    }
  }

  record(successes: number, failures: number, recovery = false) {
    // A mixed batch counts once in each relevant allowance; failures cannot
    // hide successful work, and several parallel calls are still one round.
    if (successes > 0 && !recovery) {
      this.normalRounds++;
    }
    if (recovery || failures > 0 || successes === 0) {
      this.recoveryRounds++;
    }
  }
}
