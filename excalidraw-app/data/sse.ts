/** Shared POST SSE parser: UTF-8 streaming, CRLF, multiline data and split frames. */
export async function* readSSE(stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const parse = (block: string) => {
    const lines = block.split("\n");
    return {
      event:
        lines
          .find((line) => line.startsWith("event:"))
          ?.slice(6)
          .trim() || "message",
      data: lines
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).replace(/^ /, ""))
        .join("\n"),
    };
  };
  try {
    while (true) {
      const { value, done } = await reader.read();
      buffer += done
        ? decoder.decode()
        : decoder.decode(value, { stream: true });
      // Keep a terminal CR until the next chunk, where it may form CRLF.
      buffer = buffer.replace(/\r\n/g, "\n");
      let end: number;
      while ((end = buffer.indexOf("\n\n")) !== -1) {
        const event = parse(buffer.slice(0, end));
        buffer = buffer.slice(end + 2);
        if (event.data) {
          yield event;
        }
      }
      if (buffer.length > 1024 * 1024) {
        throw new Error("流式响应帧过大");
      }
      if (done) {
        if (buffer.trim()) {
          const event = parse(buffer);
          if (event.data) {
            yield event;
          }
        }
        break;
      }
    }
  } finally {
    reader.releaseLock();
  }
}
