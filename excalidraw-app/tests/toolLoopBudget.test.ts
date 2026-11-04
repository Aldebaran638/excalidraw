import { describe, expect, it } from "vitest";

import { ToolLoopBudget } from "../server/agent/toolLoopBudget";

describe("tool loop budget", () => {
  it("allows 100 normal rounds independently of failed attempts", () => {
    const budget = new ToolLoopBudget();
    for (let i = 0; i < 99; i++) {
      budget.assertAvailable();
      budget.record(0, 1);
      budget.assertAvailable();
      budget.record(3, 0);
    }
    budget.assertAvailable();
    budget.record(1, 0);
    expect(budget.normalRounds).toBe(100);
    expect(budget.recoveryRounds).toBe(99);
    expect(() => budget.assertAvailable()).toThrow("100 次正常工具往返");
  });

  it("separately bounds failures, duplicate replay and automatic recovery", () => {
    const budget = new ToolLoopBudget();
    for (let i = 0; i < 100; i++) {
      budget.assertAvailable();
      if (i % 3 === 0) {
        budget.record(1, 0, true);
      } else if (i % 3 === 1) {
        budget.record(0, 1);
      } else {
        budget.record(0, 0);
      }
    }
    expect(budget.normalRounds).toBe(0);
    expect(() => budget.assertAvailable()).toThrow("失败重试／恢复已达 100 次");
  });

  it("counts mixed success/failure batches in both allowances, not per call", () => {
    const budget = new ToolLoopBudget();
    budget.record(20, 3);
    expect(budget.normalRounds).toBe(1);
    expect(budget.recoveryRounds).toBe(1);
  });
});
