import { ChatError } from "../chatStore";

import type { ChatMessage } from "../../data/chatTypes";

/** Resolve one reply slot. Regeneration never truncates or archives messages. */
export function resolveChatRegeneration(
  messages: ChatMessage[],
  input: {
    content: string;
    regenerateMessageId?: string;
    retryMessageId?: string;
    replaceMessageId?: string;
  },
) {
  const modes = [
    input.regenerateMessageId,
    input.retryMessageId,
    input.replaceMessageId,
  ];
  if (modes.filter((value) => value !== undefined).length > 1) {
    throw new ChatError(400, "编辑、重新生成和重试不能同时指定");
  }
  let questionIndex = -1;
  let answerIndex = -1;
  if (input.regenerateMessageId !== undefined) {
    answerIndex = messages.findIndex(
      (m) => m.id === input.regenerateMessageId && m.role === "assistant",
    );
    if (answerIndex < 0) {
      throw new ChatError(400, "要重新生成的回答不存在");
    }
    for (let i = answerIndex - 1; i >= 0; i--) {
      if (messages[i].role === "user") {
        questionIndex = i;
        break;
      }
    }
  } else if (
    input.retryMessageId !== undefined ||
    input.replaceMessageId !== undefined
  ) {
    const id = input.retryMessageId ?? input.replaceMessageId;
    questionIndex = messages.findIndex((m) => m.id === id && m.role === "user");
    if (questionIndex < 0) {
      throw new ChatError(400, "要编辑或重试的问题不存在");
    }
    if (
      input.replaceMessageId &&
      messages[questionIndex].content !== input.content
    ) {
      return { editMessageId: input.replaceMessageId, replacement: undefined };
    }
    if (
      input.retryMessageId &&
      messages.slice(questionIndex + 1).some((m) => m.role === "user")
    ) {
      throw new ChatError(400, "只能重试最后一个问题");
    }
    for (
      let i = questionIndex + 1;
      i < messages.length && messages[i].role !== "user";
      i++
    ) {
      if (messages[i].role === "assistant") {
        answerIndex = i;
      }
    }
  } else {
    return { editMessageId: undefined, replacement: undefined };
  }
  if (
    questionIndex < 0 ||
    answerIndex < 0 ||
    messages[questionIndex].content !== input.content
  ) {
    throw new ChatError(400, "重新生成必须对应原问题，不能改写问题内容");
  }
  return {
    editMessageId: undefined,
    replacement: {
      questionIndex,
      answerIndex,
      question: messages[questionIndex],
      answer: messages[answerIndex],
    },
  };
}
