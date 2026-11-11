// @vitest-environment node
import { describe, expect, it } from "vitest";

import { resolveChatRegeneration } from "../server/agent/chatRegeneration";

import type { ChatMessage } from "../data/chatTypes";
const messages: ChatMessage[] = [
  {
    id: "u1",
    turnId: "t1",
    role: "user",
    content: "first",
    status: "complete",
    createdAt: 1,
  },
  {
    id: "a1",
    turnId: "t1",
    role: "assistant",
    content: "old",
    status: "complete",
    createdAt: 1,
  },
  {
    id: "u2",
    turnId: "t2",
    role: "user",
    content: "later",
    status: "complete",
    createdAt: 2,
  },
  {
    id: "a2",
    turnId: "t2",
    role: "assistant",
    content: "failed",
    status: "failed",
    createdAt: 2,
  },
];
describe("single reply replacement", () => {
  it("selects an earlier answer without mutating later messages", () => {
    const before = structuredClone(messages);
    const result = resolveChatRegeneration(messages, {
      content: "first",
      regenerateMessageId: "a1",
    });
    expect(result.replacement?.answerIndex).toBe(1);
    expect(result.replacement?.questionIndex).toBe(0);
    expect(result.editMessageId).toBeUndefined();
    expect(messages).toEqual(before);
  });
  it("maps the legacy unchanged-edit request to regeneration", () => {
    expect(
      resolveChatRegeneration(messages, {
        content: "first",
        replaceMessageId: "u1",
      }).replacement?.answer.id,
    ).toBe("a1");
  });
  it("keeps an actual historical question edit distinct", () => {
    expect(
      resolveChatRegeneration(messages, {
        content: "changed",
        replaceMessageId: "u1",
      }).editMessageId,
    ).toBe("u1");
  });
  it("maps failure retry to the existing reply", () =>
    expect(
      resolveChatRegeneration(messages, {
        content: "later",
        retryMessageId: "u2",
      }).replacement?.answer.id,
    ).toBe("a2"));
  it.each([
    { content: "first", regenerateMessageId: "missing" },
    { content: "first", regenerateMessageId: "u1" },
    { content: "changed", regenerateMessageId: "a1" },
    { content: "first", retryMessageId: "u1" },
    { content: "first", regenerateMessageId: "a1", replaceMessageId: "u1" },
  ])("rejects an invalid or conflicting replacement %j", (input) =>
    expect(() => resolveChatRegeneration(messages, input)).toThrow(),
  );
});
