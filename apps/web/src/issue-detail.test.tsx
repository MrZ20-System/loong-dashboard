import { cleanup, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App, appQueryClient } from "./App";

vi.mock("./agent-chat", () => ({
  AgentChatPanel: () => <div>Issue chat</div>,
}));

const issue = {
  repositoryId: "repo",
  number: 7,
  title: "Render issue detail",
  url: "https://github.com/acme/repo/issues/7",
  authorLogin: "author",
  status: "open" as const,
  commentsCount: 2,
  updatedAt: "2026-09-03T02:03:04.000Z",
  createdAt: "2026-09-01T00:00:00.000Z",
  closedAt: null,
  detailBody: "# Bug report\n\nBody paragraph with **emphasis**.",
  comments: [
    {
      id: 11,
      authorLogin: "alice",
      body: "First comment paragraph.",
      createdAt: "2026-09-03T02:04:00.000Z",
      updatedAt: "2026-09-03T02:05:00.000Z",
      url: "https://github.com/acme/repo/issues/7#issuecomment-11",
    },
    {
      id: 12,
      authorLogin: "bob",
      body: "Second comment paragraph.",
      createdAt: "2026-09-03T03:00:00.000Z",
      updatedAt: "2026-09-03T03:00:00.000Z",
      url: "https://github.com/acme/repo/issues/7#issuecomment-12",
    },
  ],
};

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function renderIssueDetail(): void {
  const fetchMock = vi.fn<typeof fetch>(async (input) => {
    const url = new URL(String(input), "http://localhost");
    if (url.pathname === "/api/auth/status") return json({ enabled: false, unlocked: true });
    expect(url.pathname).toBe("/api/repositories/repo/issues/7");
    return json(issue);
  });
  vi.stubGlobal("fetch", fetchMock);
  render(
    <MemoryRouter initialEntries={["/repositories/repo/issues/7"]}>
      <App />
    </MemoryRouter>,
  );
}

describe("Issue detail page", () => {
  afterEach(() => {
    cleanup();
    appQueryClient.clear();
    vi.unstubAllGlobals();
  });

  it("renders the Markdown body, each Markdown comment with GitHub links, and Agent Chat", async () => {
    renderIssueDetail();

    const heading = await screen.findByRole("heading", {
      name: /Render issue detail/,
    });
    expect(
      within(heading).getByRole("link", {
        name: "Open issue #7 on GitHub",
      }),
    ).toHaveAttribute("href", issue.url);
    expect(
      screen.queryByRole("link", { name: "Open on GitHub" }),
    ).not.toBeInTheDocument();
    expect(screen.getByText("open")).toHaveClass(
      "pr-status-pill",
      "pr-status-pill--open",
    );
    expect(
      screen.getByRole("heading", { name: "Bug report" }),
    ).toBeInTheDocument();
    expect(screen.getByText(/Body paragraph with/)).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "Comments" }),
    ).toBeInTheDocument();

    const commentSection = screen.getByRole("heading", { name: "Comments" }).closest("section");
    expect(commentSection).not.toBeNull();
    const comments = within(commentSection as HTMLElement).getAllByRole("listitem");
    expect(comments).toHaveLength(2);
    expect(comments[0]).toHaveTextContent("alice");
    expect(comments[0]).toHaveTextContent("First comment paragraph.");
    expect(comments[0]).toHaveTextContent(
      "2026-09-03T02:04:00.000Z",
    );
    expect(comments[0]).toHaveTextContent(
      "2026-09-03T02:05:00.000Z",
    );
    expect(comments[1]).toHaveTextContent("bob");
    expect(comments[1]).toHaveTextContent("Second comment paragraph.");

    const commentLinks = screen.getAllByRole("link", { name: "GitHub" });
    expect(commentLinks.map((link) => link.getAttribute("href"))).toEqual([
      issue.comments[0]?.url,
      issue.comments[1]?.url,
    ]);
    expect(screen.getByText("Issue chat")).toBeInTheDocument();
  });
});
