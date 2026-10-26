import { Parser } from "parse5";

import type { AppLibrary } from "./appLibraries";

export type LibraryPiece = { html: string } | { library: AppLibrary };
/** A real HTML parser, not a regexp: do not mistake comments, attributes or JS
 * strings for scripts. Only pinned, identical-version mirrors are intercepted. */
export class HtmlLibraryStream {
  private parser = new Parser({ sourceCodeLocationInfo: true });
  private source = "";
  private offset = 0;
  private pieces: LibraryPiece[] = [];
  private suppressed: { start: number; name: AppLibrary } | null = null;
  constructor() {
    const parser = this.parser as any;
    for (const method of [
      "onStartTag",
      "onEndTag",
      "onCharacter",
      "onWhitespaceCharacter",
      "onNullCharacter",
      "onComment",
      "onDoctype",
    ]) {
      const original = parser[method].bind(parser);
      parser[method] = (token: any) => {
        const location = token.location;
        if (
          method === "onStartTag" &&
          token.tagName === "script" &&
          location &&
          location.startOffset >= this.offset &&
          !this.suppressed
        ) {
          const src = token.attrs.find((a: any) => a.name === "src")?.value;
          const name =
            src === "https://cdn.jsdelivr.net/npm/d3@7.9.0/dist/d3.min.js"
              ? "d3"
              : src ===
                "https://cdn.jsdelivr.net/npm/mermaid@11.12.2/dist/mermaid.min.js"
              ? "mermaid"
              : null;
          if (name) {
            this.emit(location.startOffset);
            this.suppressed = { start: location.startOffset, name };
          }
        }
        original(token);
        if (
          method === "onEndTag" &&
          token.tagName === "script" &&
          this.suppressed &&
          location
        ) {
          this.pieces.push({ library: this.suppressed.name });
          this.offset = location.endOffset;
          this.suppressed = null;
        } else if (location && !this.suppressed) {
          this.emit(location.endOffset);
        }
      };
    }
  }
  private emit(end: number) {
    if (end > this.offset) {
      const html = this.source.slice(this.offset, end);
      const last = this.pieces.at(-1);
      if (last && "html" in last) {
        last.html += html;
      } else {
        this.pieces.push({ html });
      }
      this.offset = end;
    }
  }
  push(chunk: string, final = false) {
    this.source += chunk;
    this.parser.tokenizer.write(chunk, final);
    if (final && !this.suppressed) {
      this.emit(this.source.length);
    }
    return this.pieces.splice(0);
  }
}
