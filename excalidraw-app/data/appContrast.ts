/** An obvious unreadable main heading check, not full WCAG certification.
 * Unknown paints, gradients and ancestor opacity are excluded, not guessed. */
export function inspectHeadingContrast(doc: Document) {
  const win = doc.defaultView!;
  const title = doc.getElementById("app-title") || doc.querySelector("h1");
  if (!title || !title.getBoundingClientRect().height) {
    return [];
  }
  const rgb = (value: string) => {
    const match = /^rgba?\(([^)]+)\)$/.exec(value);
    if (!match || match[1].includes("%")) {
      return null;
    }
    const color = match[1]
      .trim()
      .split(/[,\s/]+/)
      .map(Number);
    if (color.length === 3) {
      color.push(1);
    }
    return color.length === 4 && color.every(Number.isFinite) ? color : null;
  };
  const layers: number[][] = [];
  let opaque = false;
  for (let node: Element | null = title; node; node = node.parentElement) {
    const style = win.getComputedStyle(node);
    if (
      Number(style.opacity || 1) < 1 ||
      (style.filter && style.filter !== "none")
    ) {
      return [];
    }
    // Ancestor opacity/filter still affects an already opaque local paint.
    if (opaque) {
      continue;
    }
    if (style.backgroundImage && style.backgroundImage !== "none") {
      return [];
    }
    const color = rgb(style.backgroundColor);
    if (!color) {
      return [];
    }
    layers.push(color);
    if (color[3] === 1) {
      opaque = true;
    }
  }
  const foreground = rgb(win.getComputedStyle(title).color);
  if (!opaque || !foreground) {
    return [];
  }
  const mix = (top: number[], bottom: number[]) =>
    top
      .slice(0, 3)
      .map((channel, index) => channel * top[3] + bottom[index] * (1 - top[3]));
  let background = layers.pop()!;
  for (const layer of layers.reverse()) {
    background = mix(layer, background);
  }
  const luminance = (color: number[]) => {
    const linear = color.slice(0, 3).map((channel) => {
      const c = channel / 255;
      return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
  };
  const a = luminance(mix(foreground, background));
  const b = luminance(background);
  const ratio = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
  return ratio < 3
    ? [
        `主标题与实际背景对比度仅${ratio.toFixed(
          2,
        )}:1，明显难以阅读。请保留布局、知识和状态，改用语义文字色var(--text)，或设置同时可读的明确背景与前景；不要在透明深色背景上写死深色标题。`,
      ]
    : [];
}
