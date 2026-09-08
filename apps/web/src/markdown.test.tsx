import { render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import mermaid from "mermaid";
import { MarkdownView } from "./markdown";

vi.mock("mermaid", () => ({
  default: {
    initialize: vi.fn(),
    render: vi.fn(),
  },
}));

const renderMock = vi.mocked(mermaid.render);

afterEach(() => {
  vi.clearAllMocks();
});

describe("MarkdownView", () => {
  it("renders headings, paragraphs, inline code, emphasis, and links", () => {
    const { container } = render(
      <MarkdownView
        text={"## Title\n\nA line with `code`, **bold**, *emphasis*, and [a link](https://example.com).\n\nplain text"}
      />,
    );
    expect(screen.getByRole("heading", { level: 2, name: "Title" })).toBeTruthy();
    expect(screen.getByText(/a link/).closest("a")?.getAttribute("href")).toBe("https://example.com");
    expect(screen.getByText("plain text")).toBeTruthy();
    const paragraph = container.querySelector(".markdown-view p");
    expect(paragraph?.textContent).toContain("A line with");
    expect(paragraph?.querySelector("code")?.textContent).toBe("code");
    expect(paragraph?.querySelector("strong")?.textContent).toBe("bold");
    expect(paragraph?.querySelector("em")?.textContent).toBe("emphasis");
  });

  it("escapes raw HTML from messages", () => {
    const { container } = render(<MarkdownView text={'<script>alert("x")</script>\n\nsafe **text**'} />);
    expect(document.querySelector("script")).toBeNull();
    const view = container.querySelector(".markdown-view");
    expect(view?.textContent).toContain('alert("x")');
    expect(view?.textContent).toContain("safe text");
    expect(container.innerHTML).not.toMatch(/<script/i);
  });

  it("renders ordinary fenced code blocks without interpreting content", () => {
    render(<MarkdownView text={"```ts\nconst x: number = 1;\n```"} />);
    const code = document.querySelector("pre code");
    expect(code?.textContent).toContain("const x: number = 1;");
    expect(renderMock).not.toHaveBeenCalled();
  });

  it("renders GFM tables", () => {
    render(<MarkdownView text={"| name | value |\n| --- | --- |\n| a | 1 |\n| b | 2 |"} />);
    const table = screen.getByRole("table");
    expect(within(table).getByRole("columnheader", { name: "name" })).toBeTruthy();
    expect(within(table).getByRole("columnheader", { name: "value" })).toBeTruthy();
    expect(within(table).getByRole("cell", { name: "1" })).toBeTruthy();
    expect(within(table).getByRole("cell", { name: "2" })).toBeTruthy();
  });

  it("renders GFM task lists", () => {
    render(<MarkdownView text={"- [x] done\n- [ ] pending"} />);
    const boxes = screen.getAllByRole("checkbox");
    expect(boxes).toHaveLength(2);
    expect(boxes[0]).toBeChecked();
    expect(boxes[1]).not.toBeChecked();
  });

  it("rewrites relative Knowledge image URLs against the document directory", () => {
    render(
      <MarkdownView
        text={"![diagram](../assets/a.png)"}
        documentPath="notes/guide.md"
      />,
    );
    const image = screen.getByRole("img", { name: "diagram" });
    expect(image.getAttribute("src")).toBe("/api/knowledge/assets?path=assets%2Fa.png");
  });

  it("does not rewrite images for non-knowledge callers", () => {
    render(<MarkdownView text={"![diagram](../assets/a.png)"} />);
    expect(screen.queryByRole("img", { name: "diagram" })).toBeNull();
    expect(screen.queryByText(/api\/knowledge\/assets/)).toBeNull();
  });

  it("renders only the Markdown body for a Knowledge preview with LF front matter", () => {
    const { container } = render(
      <MarkdownView
        text={"---\nloongboard_id: doc_abc123\ntitle: Guide\n---\n\n# Real heading\n\nBody paragraph"}
        documentPath="notes/guide.md"
      />,
    );
    const view = within(container);
    expect(view.getByRole("heading", { level: 1, name: "Real heading" })).toBeTruthy();
    expect(view.getByText("Body paragraph")).toBeTruthy();
    expect(container.textContent).not.toContain("loongboard_id");
    expect(container.textContent).not.toContain("title: Guide");
    expect(view.queryByRole("heading", { level: 2 })).toBeNull();
  });

  it("renders only the Markdown body for a Knowledge preview with CRLF front matter", () => {
    const { container } = render(
      <MarkdownView
        text={"---\r\nloongboard_id: doc_abc123\r\ntitle: Guide\r\n---\r\n\r\n# Real heading\r\n\r\nBody paragraph"}
        documentPath="notes/guide.md"
      />,
    );
    const view = within(container);
    expect(view.getByRole("heading", { level: 1, name: "Real heading" })).toBeTruthy();
    expect(view.getByText("Body paragraph")).toBeTruthy();
    expect(container.textContent).not.toContain("loongboard_id");
    expect(container.textContent).not.toContain("title: Guide");
    expect(view.queryByRole("heading", { level: 2 })).toBeNull();
  });

  it("does not strip front matter for non-knowledge callers", () => {
    const { container } = render(
      <MarkdownView text={"---\nplain message\n---\n\n# Real heading"} />,
    );
    expect(container.textContent).toContain("plain message");
    expect(container.textContent).toContain("Real heading");
  });

  it("renders mermaid fences and rerenders when content changes", () => {
    renderMock.mockResolvedValue({
      svg: "<svg aria-label=\"flow\"></svg>",
      diagramType: "flowchart",
    });
    const first = "flowchart LR\n  A --> B";
    const second = "flowchart LR\n  A --> C";
    const { rerender } = render(<MarkdownView text={"```mermaid\n" + first + "\n```"} />);
    rerender(<MarkdownView text={"```mermaid\n" + second + "\n```"} />);
    expect(renderMock).toHaveBeenCalledTimes(2);
    expect(renderMock.mock.calls[0]?.[1]).toContain(first);
    expect(renderMock.mock.calls[1]?.[1]).toContain(second);
  });

  it("degrades a broken mermaid block to code plus a brief error", async () => {
    renderMock.mockRejectedValueOnce(new Error("syntax error in graph"));
    render(<MarkdownView text={"```mermaid\nflowchart LR\n  A ---\n```"} />);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Mermaid diagram failed");
    expect(alert.textContent).toContain("syntax error in graph");
    expect(document.querySelector("pre code")?.textContent).toContain("A ---");
  });
});
