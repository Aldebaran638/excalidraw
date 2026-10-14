import katex from "katex";

// KaTeX parses the formula; this small MathML layout emits only trusted SVG.
// Both interactive and exported formulas use this exact rendering path.
type MathNode = { tag: string; text: string; children: MathNode[] };
type Box = { width: number; height: number; svg: string };
const escape = (text: string) =>
  text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
const move = (box: Box, x: number, y: number) =>
  `<g transform="translate(${x} ${y})">${box.svg}</g>`;
const row = (boxes: Box[]): Box => {
  const height = Math.max(20, ...boxes.map((b) => b.height));
  let width = 0;
  let svg = "";
  for (const box of boxes) {
    svg += move(box, width, (height - box.height) / 2);
    width += box.width;
  }
  return { width, height, svg };
};
const parse = (xml: string) => {
  const root: MathNode = { tag: "root", text: "", children: [] };
  const stack = [root];
  for (const token of xml.match(/<[^>]*>|[^<]+/g) || []) {
    if (token.startsWith("</")) {
      if (stack.length > 1) {
        stack.pop();
      }
    } else if (token.startsWith("<")) {
      const tag = token.match(/^<([\w-]+)/)?.[1];
      if (!tag) {
        continue;
      }
      const node = { tag, text: "", children: [] };
      stack[stack.length - 1].children.push(node);
      if (!token.endsWith("/>")) {
        stack.push(node);
      }
    } else {
      stack[stack.length - 1].text += token
        .replace(/&#x([\da-f]+);/gi, (_, n) =>
          String.fromCodePoint(parseInt(n, 16)),
        )
        .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&amp;/g, "&");
    }
  }
  return root;
};
const layout = (node: MathNode, size: number): Box => {
  if (node.tag === "annotation") {
    return { width: 0, height: 0, svg: "" };
  }
  if (node.tag === "semantics") {
    return layout(node.children[0], size);
  }
  if (["mi", "mn", "mo", "mtext"].includes(node.tag)) {
    return {
      width: Math.max(4, [...node.text].length * size * 0.65),
      height: size * 1.4,
      svg: `<text y="${size}" font-size="${size}" font-family="serif"${
        node.tag === "mi" ? ' font-style="italic"' : ""
      }>${escape(node.text)}</text>`,
    };
  }
  if (node.tag === "mspace") {
    return { width: size / 3, height: size, svg: "" };
  }
  const children = node.children.map((child) => layout(child, size));
  if (node.tag === "mfrac" && children.length === 2) {
    const [a, b] = children;
    const width = Math.max(a.width, b.width) + 10;
    return {
      width,
      height: a.height + b.height + 8,
      svg: `${move(a, (width - a.width) / 2, 0)}<path d="M2 ${a.height + 3}H${
        width - 2
      }" fill="none" stroke="currentColor"/>${move(
        b,
        (width - b.width) / 2,
        a.height + 8,
      )}`,
    };
  }
  if (["msub", "msup", "msubsup"].includes(node.tag) && children.length >= 2) {
    const base = children[0];
    const sub =
      node.tag !== "msup" ? layout(node.children[1], size * 0.65) : null;
    const sup =
      node.tag === "msup"
        ? layout(node.children[1], size * 0.65)
        : node.tag === "msubsup"
        ? layout(node.children[2], size * 0.65)
        : null;
    const offset = sup ? sup.height / 2 : 0;
    return {
      width: base.width + Math.max(sub?.width || 0, sup?.width || 0),
      height: base.height + offset + (sub ? sub.height / 2 : 0),
      svg:
        move(base, 0, offset) +
        (sup ? move(sup, base.width, 0) : "") +
        (sub
          ? move(sub, base.width, offset + base.height - sub.height / 2)
          : ""),
    };
  }
  if (
    ["mover", "munder", "munderover"].includes(node.tag) &&
    children.length >= 2
  ) {
    const base = children[0];
    const under =
      node.tag !== "mover" ? layout(node.children[1], size * 0.7) : null;
    const over =
      node.tag === "mover"
        ? layout(node.children[1], size * 0.7)
        : node.tag === "munderover"
        ? layout(node.children[2], size * 0.7)
        : null;
    const width = Math.max(base.width, under?.width || 0, over?.width || 0);
    return {
      width,
      height: base.height + (under?.height || 0) + (over?.height || 0),
      svg:
        (over ? move(over, (width - over.width) / 2, 0) : "") +
        move(base, (width - base.width) / 2, over?.height || 0) +
        (under
          ? move(
              under,
              (width - under.width) / 2,
              (over?.height || 0) + base.height,
            )
          : ""),
    };
  }
  if (node.tag === "msqrt") {
    const body = row(children);
    return {
      width: body.width + size,
      height: body.height + 5,
      svg: `<text y="${body.height}" font-family="serif" font-size="${
        body.height
      }">√</text><path d="M${size - 2} 2H${
        body.width + size
      }" stroke="currentColor"/>${move(body, size, 5)}`,
    };
  }
  if (node.tag === "mtable") {
    const columns: number[] = [];
    const rows = node.children.map((r) =>
      r.children.map((c, i) => {
        const box = layout(c, size);
        columns[i] = Math.max(columns[i] || 0, box.width);
        return box;
      }),
    );
    let y = 0;
    let svg = "";
    for (const cells of rows) {
      const height = Math.max(20, ...cells.map((c) => c.height));
      let x = 0;
      for (const [i, cell] of cells.entries()) {
        svg += move(cell, x + (columns[i] - cell.width) / 2, y);
        x += columns[i] + 12;
      }
      y += height + 6;
    }
    return { width: columns.reduce((a, b) => a + b + 12, 0), height: y, svg };
  }
  return row(children);
};
export const renderFormula = (
  source: string,
  width: number,
  height: number,
) => {
  try {
    const mathml = katex.renderToString(source, {
      output: "mathml",
      throwOnError: true,
      trust: false,
      strict: "ignore",
      maxExpand: 100,
      maxSize: 20,
    });
    if (mathml.length > 32768) {
      throw new Error("公式过大");
    }
    const box = layout(parse(mathml), 18);
    const scale = Math.min(
      1,
      width / Math.max(1, box.width),
      height / Math.max(1, box.height),
    );
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" aria-label="${escape(
      source,
    )}"><g fill="currentColor" transform="scale(${scale})">${
      box.svg
    }</g></svg>`;
  } catch {
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><text y="20" fill="currentColor">${escape(
      source,
    )}</text></svg>`;
  }
};
