import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { MarkdownView } from "./markdown";

describe("MarkdownView", () => {
  it("renders headings, lists, inline code, and links", () => {
    render(
      <MarkdownView
        text={"## Title\n\nA line with `code` and **bold** and [a link](https://example.com).\n\n- one\n- two"}
      />,
    );
    expect(screen.getByRole("heading", { level: 2, name: "Title" })).toBeTruthy();
    expect(screen.getByText(/a link/).closest("a")?.getAttribute("href")).toBe("https://example.com");
    expect(screen.getByRole("list").children.length).toBe(2);
  });

  it("escapes raw HTML from messages", () => {
    const { container } = render(<MarkdownView text={'<script>alert("x")</script>\n\nsafe **text**'} />);
    expect(document.querySelector("script")).toBeNull();
    expect(container.innerHTML).toContain("&lt;script&gt;");
    expect(container.innerHTML).not.toContain('<script>alert');
    expect(document.body.textContent).toContain("safe text");
  });

  it("renders fenced code blocks without interpreting content", () => {
    render(<MarkdownView text={"```ts\nconst x: number = 1;\n```"} />);
    const code = document.querySelector("pre code");
    expect(code?.textContent).toContain("const x: number = 1;");
  });
});
