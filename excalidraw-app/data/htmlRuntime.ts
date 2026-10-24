import { installIframeOverlayScrollbars } from "./iframeOverlayScrollbars";
import { HTML_THEME_CSS } from "./htmlEnvironment";

import type { HtmlState } from "./chatHtml";

/** Runs only inside an opaque-origin sandbox. Native document parser retains
 * incomplete HTML/script tokens between writes and executes each script once. */
function bootstrap(
  token: string,
  initial: HtmlState,
  runtimeVersion: number,
  captureSource: string,
  installScrollbars: typeof installIframeOverlayScrollbars,
  themeCSS: string,
) {
  const win = window;
  // Opening from an inline script while its parser is active is ignored by
  // browsers. Wait for the bootstrap load, then keep our own parser open.
  win.addEventListener(
    "load",
    () => {
      const doc = win.document;
      let capturePng:
        | ((node: HTMLElement, options: unknown) => Promise<string>)
        | undefined;
      const state = initial;
      let ended = false;
      let historyEnabled = false;
      let stateScheduled = false;
      const send = (type: string, data?: unknown) => {
        if (type === "state") {
          if (!stateScheduled) {
            stateScheduled = true;
            win.queueMicrotask(() => {
              stateScheduled = false;
              win.parent.postMessage({ token, type, data: state }, "*");
            });
          }
          return;
        }
        win.parent.postMessage({ token, type, data }, "*");
      };
      const policy =
        "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src 'none'; connect-src 'none'; frame-src 'none'; worker-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";
      doc.open();
      const initializers = new Map<string, (() => void) | undefined>();
      const listeners = new Map<
        string,
        {
          update: (handler: (event: Event, target: Element) => void) => void;
          cleanup: () => void;
        }
      >();
      const timers = new Map<
        string,
        { id: number; ms: number; callback: () => void }
      >();
      const regions = new Set<Element>();
      let disposed = false;
      let disposeScrollbars = () => {};
      const keyFor = (key: string) => {
        if (typeof key !== "string" || !key || key.length > 200) {
          throw new Error("生命周期 key 不正确");
        }
        if (disposed) {
          throw new Error("应用已停止，请重新运行");
        }
        return key;
      };
      const targetFor = (id: string) => {
        if (typeof id !== "string" || !id || id.length > 200) {
          throw new Error("节点 ID 不正确");
        }
        const matches = Array.from(
          doc.querySelectorAll<HTMLElement>("[id]"),
        ).filter((node) => node.id === id);
        if (matches.length !== 1 || !doc.body.contains(matches[0])) {
          throw new Error(
            matches.length > 1 ? "节点 ID 重复" : "目标节点不存在",
          );
        }
        return matches[0];
      };
      const clearTimer = (key: string) => {
        const timer = timers.get(key);
        if (timer) {
          win.clearInterval(timer.id);
          timers.delete(key);
        }
      };
      const cleanup = () => {
        if (disposed) {
          return;
        }
        disposed = true;
        ended = true;
        disposeScrollbars();
        for (const timer of timers.values()) {
          win.clearInterval(timer.id);
        }
        timers.clear();
        for (const listener of listeners.values()) {
          listener.cleanup();
        }
        listeners.clear();
        for (const dispose of initializers.values()) {
          try {
            dispose?.();
          } catch {
            /* Continue disposing the other regions. */
          }
        }
        initializers.clear();
        regions.clear();
      };
      win.addEventListener("pagehide", cleanup, { once: true });
      const lifecycle =
        runtimeVersion >= 2
          ? {
              once: (key: string, setup: () => void | (() => void)) => {
                keyFor(key);
                if (typeof setup !== "function") {
                  throw new Error("setup 必须是函数");
                }
                if (initializers.has(key)) {
                  return;
                }
                const root = doc.getElementById(key) ? targetFor(key) : null;
                initializers.set(key, undefined);
                if (root) {
                  regions.add(root);
                }
                try {
                  const dispose = setup();
                  if (typeof dispose === "function") {
                    initializers.set(key, dispose);
                  }
                } catch (error) {
                  initializers.delete(key);
                  if (root) {
                    regions.delete(root);
                  }
                  throw error;
                }
              },
              on: (
                key: string,
                rootId: string,
                eventName: string,
                selector: string,
                handler: (event: Event, target: Element) => void,
              ) => {
                keyFor(key);
                const root = targetFor(rootId);
                if (
                  ![
                    "click",
                    "input",
                    "change",
                    "keydown",
                    "submit",
                    "pointerup",
                  ].includes(eventName) ||
                  typeof selector !== "string" ||
                  selector.length > 500 ||
                  typeof handler !== "function"
                ) {
                  throw new Error("事件委托参数不正确");
                }
                root.querySelector(selector); // Validate the selector without touching application state.
                const previous = listeners.get(key);
                if (previous) {
                  previous.cleanup();
                }
                let callback = handler;
                const listener = (event: Event) => {
                  const node = event.target as Element;
                  const target = node?.closest?.(selector);
                  if (target && root.contains(target)) {
                    callback(event, target);
                  }
                };
                root.addEventListener(eventName, listener);
                regions.add(root);
                listeners.set(key, {
                  update: (next) => {
                    callback = next;
                  },
                  cleanup: () => root.removeEventListener(eventName, listener),
                });
              },
              interval: (key: string, callback: () => void, ms: number) => {
                keyFor(key);
                if (
                  typeof callback !== "function" ||
                  !Number.isFinite(ms) ||
                  ms < 50 ||
                  ms > 3600000
                ) {
                  throw new Error("计时任务参数不正确");
                }
                const old = timers.get(key);
                if (old && old.ms === ms) {
                  old.callback = callback;
                  return;
                }
                clearTimer(key);
                const timer = { id: 0, ms, callback };
                timer.id = win.setInterval(() => timer.callback(), ms);
                timers.set(key, timer);
              },
              clearInterval: clearTimer,
              patch: (targetId: string, changes: Record<string, unknown>) => {
                try {
                  const target = targetFor(targetId);
                  if (
                    !changes ||
                    typeof changes !== "object" ||
                    Array.isArray(changes) ||
                    Object.keys(changes).some(
                      (key) =>
                        ![
                          "text",
                          "style",
                          "attrs",
                          "appendHtml",
                          "remove",
                        ].includes(key),
                    )
                  ) {
                    throw new Error("不支持的局部更新字段");
                  }
                  const actions: (() => void)[] = [];
                  const editing =
                    "input,textarea,select,[contenteditable]:not([contenteditable=false])";
                  const protectedTree = () =>
                    target.matches(editing) ||
                    Boolean(
                      target.closest(
                        "[contenteditable]:not([contenteditable=false])",
                      ),
                    ) ||
                    Boolean(target.querySelector(editing)) ||
                    (doc.activeElement !== doc.body &&
                      target.contains(doc.activeElement)) ||
                    [...regions].some((root) => target.contains(root));
                  if (changes.text !== undefined) {
                    if (
                      typeof changes.text !== "string" ||
                      changes.text.length > 20000 ||
                      protectedTree()
                    ) {
                      throw new Error(
                        "不能通过文本更新覆盖输入、焦点或已初始化的运行区域",
                      );
                    }
                    actions.push(() => {
                      target.textContent = changes.text as string;
                    });
                  }
                  if (changes.remove !== undefined) {
                    if (
                      changes.remove !== true ||
                      protectedTree() ||
                      Object.keys(changes).length !== 1
                    ) {
                      throw new Error("不能移除正在使用的输入或运行区域");
                    }
                    actions.push(() => target.remove());
                  }
                  const focused =
                    doc.activeElement !== doc.body &&
                    target.contains(doc.activeElement);
                  if (changes.style !== undefined) {
                    if (
                      !changes.style ||
                      typeof changes.style !== "object" ||
                      Array.isArray(changes.style)
                    ) {
                      throw new Error("style 必须是对象");
                    }
                    for (const [property, value] of Object.entries(
                      changes.style,
                    )) {
                      if (
                        typeof value !== "string" ||
                        value.length > 1000 ||
                        !/^(--[a-zA-Z0-9_-]+|[a-zA-Z][a-zA-Z0-9-]*)$/.test(
                          property,
                        )
                      ) {
                        throw new Error("样式更新不正确");
                      }
                      const name = property.startsWith("--")
                        ? property
                        : property.replace(
                            /[A-Z]/g,
                            (letter) => `-${letter.toLowerCase()}`,
                          );
                      if (
                        focused &&
                        ((name === "display" && value === "none") ||
                          (name === "visibility" && value !== "visible") ||
                          (name === "pointer-events" && value === "none"))
                      ) {
                        throw new Error("不能隐藏正在操作的区域");
                      }
                      actions.push(() => target.style.setProperty(name, value));
                    }
                  }
                  if (changes.attrs !== undefined) {
                    if (
                      !changes.attrs ||
                      typeof changes.attrs !== "object" ||
                      Array.isArray(changes.attrs)
                    ) {
                      throw new Error("attrs 必须是对象");
                    }
                    for (const [name, value] of Object.entries(changes.attrs)) {
                      if (
                        !/^(class|title|role|aria-[a-z-]+|data-[a-z-]+)$/.test(
                          name,
                        ) ||
                        typeof value !== "string" ||
                        value.length > 2000 ||
                        (focused && name === "class")
                      ) {
                        throw new Error("不能修改输入值或影响当前焦点的属性");
                      }
                      actions.push(() => target.setAttribute(name, value));
                    }
                  }
                  if (changes.appendHtml !== undefined) {
                    if (
                      typeof changes.appendHtml !== "string" ||
                      changes.appendHtml.length > 65536 ||
                      target.matches(editing)
                    ) {
                      throw new Error("追加内容不正确");
                    }
                    const template = doc.createElement("template");
                    template.innerHTML = changes.appendHtml;
                    if (
                      template.content.querySelector(
                        "script,iframe,object,embed,base,meta",
                      )
                    ) {
                      throw new Error(
                        "追加 HTML 不能包含脚本或嵌套文档；请在后续完整 script 中安装逻辑",
                      );
                    }
                    const ids = new Set<string>();
                    for (const node of Array.from(
                      template.content.querySelectorAll("*"),
                    )) {
                      if (node.id) {
                        if (ids.has(node.id) || doc.getElementById(node.id)) {
                          throw new Error("追加内容包含重复 ID");
                        }
                        ids.add(node.id);
                      }
                      if (
                        Array.from(node.attributes).some(
                          (attr) =>
                            /^on/i.test(attr.name) ||
                            attr.name === "srcdoc" ||
                            /^javascript:/i.test(attr.value),
                        )
                      ) {
                        throw new Error("追加 HTML 不能隐式安装执行逻辑");
                      }
                    }
                    actions.push(() => target.appendChild(template.content));
                  }
                  actions.forEach((action) => action());
                  send("patch_applied", { targetId });
                  return { applied: true };
                } catch (error) {
                  const reason = (error as Error).message;
                  send("patch_rejected", {
                    targetId: typeof targetId === "string" ? targetId : "?",
                    reason,
                  });
                  return { applied: false, reason };
                }
              },
            }
          : {};
      // document.open removes DOM listeners; install the bridge after opening.
      Object.defineProperty(win, "NoteApp", {
        value: Object.freeze({
          ...lifecycle,
          get: (key: string, fallback: unknown) =>
            Object.prototype.hasOwnProperty.call(state.custom, key)
              ? JSON.parse(JSON.stringify(state.custom[key]))
              : fallback,
          set: (key: string, value: unknown) => {
            if (["__proto__", "prototype", "constructor"].includes(key)) {
              return;
            }
            const copy = JSON.parse(JSON.stringify(value));
            if (JSON.stringify(copy).length > 60000) {
              throw new Error("状态过大");
            }
            if (JSON.stringify(state.custom[key]) === JSON.stringify(copy)) {
              return;
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
        if (event.data.type === "history_support") {
          historyEnabled = event.data.data === true;
          return;
        }
        if (event.data.type === "dispose") {
          cleanup();
          return;
        }
        if (event.data.type === "capture") {
          if (
            !captureSource &&
            typeof event.data.data?.library === "string" &&
            event.data.data.library.length < 200000
          ) {
            captureSource = event.data.data.library;
          }
          const requestId = event.data.requestId;
          void (async () => {
            let holder: HTMLElement | undefined;
            try {
              if (!capturePng && captureSource) {
                const library = doc.createElement("script");
                library.textContent = captureSource;
                doc.head.appendChild(library);
                capturePng = (win as any).htmlToImage?.toPng;
                library.remove();
              }
              if (!capturePng || !ended) {
                throw new Error("应用尚未就绪，无法导出当前画面");
              }
              const width = Math.ceil(win.innerWidth);
              const height = Math.ceil(win.innerHeight);
              if (width * height > 4000000) {
                throw new Error("组件尺寸超过快照上限，请缩小后重试");
              }
              const clone = (original: Element): Element | null => {
                if (
                  ["SCRIPT", "STYLE", "LINK", "META", "IFRAME"].includes(
                    original.tagName,
                  )
                ) {
                  return null;
                }
                let copy: Element;
                if (original instanceof win.HTMLCanvasElement) {
                  copy = doc.createElement("img");
                  copy.setAttribute("src", original.toDataURL());
                } else if (original === doc.body) {
                  copy = doc.createElement("div");
                } else {
                  copy = original.cloneNode(false) as Element;
                }
                if ((copy as HTMLElement).style) {
                  const style = win.getComputedStyle(original);
                  for (const key of Array.from(style)) {
                    (copy as HTMLElement).style.setProperty(
                      key,
                      style.getPropertyValue(key),
                    );
                  }
                  (copy as HTMLElement).style.setProperty("animation", "none");
                  (copy as HTMLElement).style.setProperty("transition", "none");
                  (copy as HTMLElement).style.setProperty(
                    "caret-color",
                    "transparent",
                  );
                }
                for (const attr of Array.from(copy.attributes)) {
                  if (attr.name.startsWith("on")) {
                    copy.removeAttribute(attr.name);
                  }
                }
                if (!(original instanceof win.HTMLCanvasElement)) {
                  for (const child of Array.from(original.childNodes)) {
                    const value =
                      child.nodeType === 1
                        ? clone(child as Element)
                        : child.cloneNode(true);
                    if (value) {
                      copy.appendChild(value);
                    }
                  }
                }
                if (original instanceof win.HTMLInputElement) {
                  (copy as HTMLInputElement).value = original.value;
                  (copy as HTMLInputElement).checked = original.checked;
                  if (original.checked) {
                    copy.setAttribute("checked", "");
                  } else {
                    copy.removeAttribute("checked");
                  }
                }
                if (original instanceof win.HTMLTextAreaElement) {
                  (copy as HTMLTextAreaElement).value = original.value;
                }
                if (original instanceof win.HTMLSelectElement) {
                  (copy as HTMLSelectElement).value = original.value;
                }
                if (original.scrollLeft || original.scrollTop) {
                  const style = (copy as HTMLElement).style;
                  if (style) {
                    style.overflow = "hidden";
                    for (const child of Array.from(copy.children)) {
                      if ((child as HTMLElement).style) {
                        const childStyle = (child as HTMLElement).style;
                        childStyle.transform = `translate(${-original.scrollLeft}px,${-original.scrollTop}px) ${
                          childStyle.transform === "none"
                            ? ""
                            : childStyle.transform
                        }`;
                      }
                    }
                  }
                }
                return copy;
              };
              holder = doc.createElement("div");
              holder.style.cssText = `position:fixed;left:0;top:0;z-index:-2147483647;width:${width}px;height:${height}px;overflow:hidden;pointer-events:none;`;
              holder.style.backgroundColor = win.getComputedStyle(
                doc.body,
              ).backgroundColor;
              const copied = clone(doc.body) as HTMLElement;
              copied.style.margin = "0";
              copied.style.transform = `translate(${-win.scrollX}px,${-win.scrollY}px)`;
              holder.appendChild(copied);
              doc.documentElement.appendChild(holder);
              const png = await capturePng(holder, {
                width,
                height,
                pixelRatio: 1.5,
                skipFonts: true,
                style: {
                  left: "0",
                  top: "0",
                  position: "relative",
                  zIndex: "auto",
                },
              });
              send("capture_result", { requestId, png, width, height });
            } catch (error) {
              send("capture_result", { requestId, error: String(error) });
            } finally {
              holder?.remove();
            }
          })();
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
        if (
          event.key === "Enter" &&
          (event.target as Element)?.closest?.("input")
        ) {
          send("state", state);
        }
        if (
          historyEnabled &&
          (event.ctrlKey || event.metaKey) &&
          ["z", "y"].includes(event.key.toLowerCase()) &&
          !(event.target as Element)?.closest?.(
            'input,textarea,select,[contenteditable="true"]',
          )
        ) {
          event.preventDefault();
          send(
            "history",
            event.shiftKey || event.key.toLowerCase() === "y" ? "redo" : "undo",
          );
          return;
        }
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
          send("state_preview", state);
        }
      });
      doc.addEventListener("change", () => send("state", state));
      doc.addEventListener("focusout", (event) => {
        if ((event.target as Element)?.closest?.("input,textarea,select")) {
          send("state", state);
        }
      });
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
  ${themeCSS}
  *{box-sizing:border-box}body{margin:0;padding:16px;font:14px/1.6 system-ui,sans-serif;background:var(--surface);color:var(--text);overflow-wrap:anywhere}label{display:block;font-weight:500;margin-block:6px}input,select,textarea,button{font:inherit;max-width:100%}input:not([type=checkbox]):not([type=radio]),select,textarea{width:100%}input,select,button{min-height:44px}button,.button{cursor:pointer;border:1px solid var(--border);border-radius:8px;padding:8px 12px;color:inherit;background:var(--surface)}input,select,textarea{padding:8px;border:1px solid var(--border);border-radius:6px;background:var(--surface);color:inherit}.card{padding:16px;border:1px solid var(--border);border-radius:12px}.row{display:flex;flex-wrap:wrap;gap:12px;align-items:center}.col{display:flex;flex-direction:column;gap:12px}.muted{color:var(--muted)}svg,canvas{max-width:100%}pre,table{max-width:100%;overflow:auto}img{max-width:100%}
  </style></head><body>`);
      disposeScrollbars = installScrollbars(doc);
      send("ready");
    },
    { once: true },
  );
}

export const htmlBootstrap = (
  token: string,
  state: HtmlState,
  runtimeVersion = 1,
  captureScript = "",
) => {
  const args = JSON.stringify([
    token,
    state,
    runtimeVersion,
    captureScript,
  ]).replace(/</g, "\\u003c");
  return `<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; connect-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'"><script>(${bootstrap.toString()})(...${args},${installIframeOverlayScrollbars.toString()},${JSON.stringify(
    HTML_THEME_CSS,
  )})</script>`;
};
