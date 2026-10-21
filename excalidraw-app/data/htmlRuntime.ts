import type { HtmlState } from "./chatHtml";

/** Runs only inside an opaque-origin sandbox. Native document parser retains
 * incomplete HTML/script tokens between writes and executes each script once. */
function bootstrap(token: string, initial: HtmlState) {
  const win = window;
  // Opening from an inline script while its parser is active is ignored by
  // browsers. Wait for the bootstrap load, then keep our own parser open.
  win.addEventListener(
    "load",
    () => {
      const doc = win.document;
      const state = initial;
      let ended = false;
      const send = (type: string, data?: unknown) =>
        win.parent.postMessage({ token, type, data }, "*");
      const policy =
        "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src 'none'; connect-src 'none'; frame-src 'none'; worker-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";
      doc.open();
      // document.open removes DOM listeners; install the bridge after opening.
      Object.defineProperty(win, "NoteApp", {
        value: Object.freeze({
          get: (key: string, fallback: unknown) =>
            Object.prototype.hasOwnProperty.call(state.custom, key)
              ? state.custom[key]
              : fallback,
          set: (key: string, value: unknown) => {
            if (["__proto__", "prototype", "constructor"].includes(key)) {
              return;
            }
            const copy = JSON.parse(JSON.stringify(value));
            if (JSON.stringify(copy).length > 60000) {
              throw new Error("状态过大");
            }
            state.custom[key] = copy;
            send("state", state);
          },
        }),
      });
      const restored = new WeakSet<Element>();
      const restore = () => {
        for (const node of Array.from(
          doc.querySelectorAll<
            HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement
          >("input[id],select[id],textarea[id]"),
        )) {
          if (restored.has(node)) {
            continue;
          }
          restored.add(node);
          const old = state.forms[node.id];
          if (old && old.type === node.type) {
            node.value = old.value;
            if ("checked" in node && old.checked !== undefined) {
              node.checked = old.checked;
            }
          }
        }
      };
      win.addEventListener("message", (event) => {
        if (event.source !== win.parent || event.data?.token !== token) {
          return;
        }
        if (event.data.type === "theme") {
          doc.documentElement.style.colorScheme =
            event.data.data === "dark" ? "dark" : "light";
          return;
        }
        if (ended) {
          return;
        }
        try {
          if (
            event.data.type === "append" &&
            typeof event.data.data === "string"
          ) {
            doc.write(event.data.data);
            restore();
          } else if (event.data.type === "finish") {
            ended = true;
            restore();
            doc.close();
            send("complete");
          }
        } catch (error) {
          send("error", String(error));
        }
      });
      win.addEventListener("error", (event) => send("error", event.message));
      win.addEventListener("unhandledrejection", (event) =>
        send("error", String(event.reason)),
      );
      win.addEventListener("keydown", (event) => {
        if (event.key === "Escape") {
          send("escape");
        }
      });
      doc.addEventListener("input", (event) => {
        const node = event.target as HTMLInputElement;
        if (
          node?.id &&
          ["INPUT", "SELECT", "TEXTAREA"].includes(node.tagName)
        ) {
          state.forms[node.id] = {
            type: node.type,
            value: node.value,
            ...("checked" in node ? { checked: node.checked } : {}),
          };
          send("state", state);
        }
      });
      doc.addEventListener("change", () => send("state", state));
      doc.addEventListener(
        "DOMContentLoaded",
        () => {
          restore();
          for (const node of Array.from(
            doc.querySelectorAll<HTMLInputElement>(
              "input[id],select[id],textarea[id]",
            ),
          )) {
            if (Object.prototype.hasOwnProperty.call(state.forms, node.id)) {
              node.dispatchEvent(new Event("input", { bubbles: true }));
            }
          }
        },
        { once: true },
      );
      doc.addEventListener("submit", (event) => event.preventDefault(), true);
      doc.addEventListener(
        "click",
        (event) => {
          if ((event.target as Element)?.closest?.("a[href]")) {
            event.preventDefault();
          }
        },
        true,
      );
      doc.write(`<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="${policy}"><meta name="viewport" content="width=device-width,initial-scale=1"><style>
  :root{color-scheme:light dark;--surface:light-dark(#fff,#232329);--text:light-dark(#1b1b1f,#f0f0f3);--muted:light-dark(#666,#bbb);--accent:#6965db;--border:light-dark(#e6e6eb,#45454b)}
  *{box-sizing:border-box}body{margin:0;padding:16px;font:14px/1.6 system-ui,sans-serif;background:var(--surface);color:var(--text);overflow-wrap:anywhere}label{display:block;font-weight:500;margin-block:6px}input,select,textarea,button{font:inherit;max-width:100%}input:not([type=checkbox]):not([type=radio]),select,textarea{width:100%}input,select,button{min-height:44px}button,.button{cursor:pointer;border:1px solid var(--border);border-radius:8px;padding:8px 12px;color:inherit;background:var(--surface)}input,select,textarea{padding:8px;border:1px solid var(--border);border-radius:6px;background:var(--surface);color:inherit}.card{padding:16px;border:1px solid var(--border);border-radius:12px}.row{display:flex;flex-wrap:wrap;gap:12px;align-items:center}.col{display:flex;flex-direction:column;gap:12px}.muted{color:var(--muted)}svg,canvas{max-width:100%}pre,table{max-width:100%;overflow:auto}img{max-width:100%}
  </style></head><body>`);
      send("ready");
    },
    { once: true },
  );
}

export const htmlBootstrap = (token: string, state: HtmlState) => {
  const args = JSON.stringify([token, state]).replace(/</g, "\\u003c");
  return `<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; connect-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'"><script>(${bootstrap.toString()})(...${args})</script>`;
};
