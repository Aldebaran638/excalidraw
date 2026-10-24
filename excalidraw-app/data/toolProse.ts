/** Framing only: text resembling a call is NEVER converted into a real call.
 * Only standalone, complete XML-style calls outside Markdown fences/quotes are
 * classified. Ordinary prose is emitted immediately, ambiguous prefixes wait. */
export class ToolProseStream {
  private pending = "";
  private lineStart = true;
  private fence = "";
  private call = false;
  constructor(
    private output: (type: "text" | "protocol", text: string) => void,
  ) {}
  push(text: string) {
    this.pending += text;
    while (this.pending) {
      if (this.call) {
        const end = this.pending.indexOf("</tool_call>");
        if (end < 0) {
          return;
        }
        const raw = this.pending.slice(0, end + 12);
        this.output(
          /^<tool_call>\s*<function(?:=|\s)/.test(raw.trim())
            ? "protocol"
            : "text",
          raw,
        );
        this.pending = this.pending.slice(end + 12);
        this.call = false;
        this.lineStart = false;
        continue;
      }
      if (this.lineStart) {
        const trimmed = this.pending.trimStart();
        if (
          !this.fence &&
          !/^(?: {4}|\t)/.test(this.pending) &&
          ("<tool_call>".startsWith(trimmed) ||
            trimmed.startsWith("<tool_call>"))
        ) {
          if (!trimmed.startsWith("<tool_call>")) {
            return;
          }
          this.call = true;
          continue;
        }
        if (/^(`|~)/.test(trimmed)) {
          const end = this.pending.indexOf("\n");
          if (end < 0) {
            return;
          }
          const marker = trimmed.match(/^(`{3,}|~{3,})/)?.[1];
          if (marker) {
            if (!this.fence) {
              this.fence = marker;
            } else if (
              marker[0] === this.fence[0] &&
              marker.length >= this.fence.length
            ) {
              this.fence = "";
            }
          }
          this.output("text", this.pending.slice(0, end + 1));
          this.pending = this.pending.slice(end + 1);
          continue;
        }
      }
      const newline = this.pending.indexOf("\n");
      if (newline < 0) {
        this.output("text", this.pending);
        this.pending = "";
        this.lineStart = false;
      } else {
        this.output("text", this.pending.slice(0, newline + 1));
        this.pending = this.pending.slice(newline + 1);
        this.lineStart = true;
      }
    }
  }
  finish() {
    if (this.pending) {
      this.output("text", this.pending);
    }
    this.pending = "";
    this.call = false;
    this.lineStart = true;
  }
}
