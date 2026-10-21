import { useMemo, useState } from "react";
import { marked } from "marked";

import type { Token, Tokens } from "marked";
import type { ReactNode } from "react";

const Code = ({ text }: { text: string }) => {
  const [status, setStatus] = useState("复制代码");
  return (
    <div className="note-chat-code">
      <button
        type="button"
        onClick={async (event) => {
          const ownerWindow = event.currentTarget.ownerDocument.defaultView;
          try {
            if (!ownerWindow?.navigator.clipboard) {
              throw new Error();
            }
            await ownerWindow.navigator.clipboard.writeText(text);
            setStatus("已复制");
          } catch {
            setStatus("请选中代码复制");
          }
        }}
      >
        {status}
      </button>
      <pre>
        <code>{text}</code>
      </pre>
    </div>
  );
};
/** Parse to tokens, never HTML. Unsupported and raw HTML tokens remain inert text. */
const render = (tokens: Token[], depth = 0): ReactNode =>
  depth > 20
    ? null
    : tokens.map((token, index) => {
        const children =
          "tokens" in token && Array.isArray(token.tokens)
            ? render(token.tokens, depth + 1)
            : "text" in token
            ? String(token.text)
            : token.raw;
        switch (token.type) {
          case "space":
            return null;
          case "paragraph":
            return <p key={index}>{children}</p>;
          case "heading":
            return <h4 key={index}>{children}</h4>;
          case "strong":
            return <strong key={index}>{children}</strong>;
          case "em":
            return <em key={index}>{children}</em>;
          case "del":
            return <del key={index}>{children}</del>;
          case "br":
            return <br key={index} />;
          case "hr":
            return <hr key={index} />;
          case "blockquote":
            return <blockquote key={index}>{children}</blockquote>;
          case "code":
            return <Code key={index} text={token.text} />;
          case "codespan":
            return <code key={index}>{token.text}</code>;
          case "table":
            return (
              <div
                className="note-chat-table"
                key={index}
                tabIndex={0}
                role="region"
                aria-label="回答中的表格"
              >
                <table>
                  <thead>
                    <tr>
                      {token.header.map((cell: Tokens.TableCell, i: number) => (
                        <th
                          key={i}
                          scope="col"
                          style={{ textAlign: token.align[i] || undefined }}
                        >
                          {render(cell.tokens, depth + 1)}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {token.rows.map((row: Tokens.TableCell[], i: number) => (
                      <tr key={i}>
                        {row.map((cell: Tokens.TableCell, j: number) => (
                          <td
                            key={j}
                            style={{ textAlign: token.align[j] || undefined }}
                          >
                            {render(cell.tokens, depth + 1)}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
          case "list":
            return token.ordered ? (
              <ol key={index}>
                {token.items.map((item: { tokens: Token[] }, i: number) => (
                  <li key={i}>{render(item.tokens, depth + 1)}</li>
                ))}
              </ol>
            ) : (
              <ul key={index}>
                {token.items.map((item: { tokens: Token[] }, i: number) => (
                  <li key={i}>{render(item.tokens, depth + 1)}</li>
                ))}
              </ul>
            );
          case "link":
            return <span key={index}>{children}</span>;
          case "image":
            return <span key={index}>[图片：{token.text}]</span>;
          default:
            return <span key={index}>{children}</span>;
        }
      });
export const NoteChatMarkdown = ({ content }: { content: string }) => {
  const output = useMemo(() => render(marked.lexer(content)), [content]);
  return <div className="note-chat-markdown">{output}</div>;
};
