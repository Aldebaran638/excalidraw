import { fireEvent, render, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { NoteChatMarkdown } from "../components/NoteChatMarkdown";

describe("safe note chat Markdown", () => {
  it("renders the model's valid tool table as safe semantic cells, including streaming prefixes", () => {
    const content =
      "| 工具 | 功能 |\n|:------|------:|\n| `get_note_outline` | 分页读取画布的大纲、标签和分组 ID |\n| `search_note` | 搜索关键词 |\n| `read_note_elements` | 读取元素详情 |";
    const { container, rerender } = render(
      <NoteChatMarkdown content={content} />,
    );
    expect(container.querySelectorAll("thead th")).toHaveLength(2);
    expect(container.querySelectorAll("tbody tr")).toHaveLength(3);
    expect(container.querySelector("td code")?.textContent).toBe(
      "get_note_outline",
    );
    expect(container.querySelector("th")?.style.textAlign).toBe("left");
    expect(container.querySelectorAll("th")[1].style.textAlign).toBe("right");
    for (const length of [4, 21, 30, 70, content.length]) {
      rerender(<NoteChatMarkdown content={content.slice(0, length)} />);
      expect(container.querySelector("script,img,iframe")).toBeNull();
    }
    expect(container.querySelectorAll("tbody tr")).toHaveLength(3);
    rerender(
      <NoteChatMarkdown
        content={"| 输入 |\n|---|\n| <img src=x onerror=alert(1)> |"}
      />,
    );
    expect(container.querySelector("table")).not.toBeNull();
    expect(container.querySelector("img")).toBeNull();
  });
  it("renders Chinese, long text, lists and code without active HTML, links or remote images", () => {
    const content = `# 中文标题\n\n${"长文本".repeat(
      1000,
    )}\n\n- 第一项\n- 第二项\n\n<script>alert(1)</script>\n\n![远程图](https://example.invalid/image.png)\n\n[执行](javascript:alert(1))\n\n\`\`\`html\n<img src=x onerror=alert(1)>\n\`\`\``;
    const { container } = render(<NoteChatMarkdown content={content} />);
    expect(container.querySelector("script,img,iframe,a")).toBeNull();
    expect(container.querySelectorAll("li")).toHaveLength(2);
    expect(container.querySelector("pre code")?.textContent).toBe(
      "<img src=x onerror=alert(1)>",
    );
    expect(container.textContent).toContain("中文标题");
    expect(container.textContent).toContain("远程图");
  });
  it("copies code through the mounted node's window", async () => {
    const { container, getByRole } = render(
      <NoteChatMarkdown content={"```cpp\nint main() {}\n```"} />,
    );
    const ownerWindow = container.ownerDocument.defaultView!;
    const original = Object.getOwnPropertyDescriptor(
      ownerWindow.navigator,
      "clipboard",
    );
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(ownerWindow.navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    try {
      fireEvent.click(getByRole("button", { name: "复制代码" }));
      await waitFor(() =>
        expect(writeText).toHaveBeenCalledWith("int main() {}"),
      );
      expect(getByRole("button", { name: "已复制" })).toBeTruthy();
    } finally {
      if (original) {
        Object.defineProperty(ownerWindow.navigator, "clipboard", original);
      } else {
        Reflect.deleteProperty(ownerWindow.navigator, "clipboard");
      }
    }
  });
});
