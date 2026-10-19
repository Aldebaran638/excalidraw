import { fireEvent, render, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { NoteChatMarkdown } from "../components/NoteChatMarkdown";

describe("safe note chat Markdown", () => {
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
