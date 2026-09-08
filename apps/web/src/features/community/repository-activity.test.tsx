import { cleanup, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App, appQueryClient } from "../../App";

const repository = {
  id: "repo",
  key: "repo",
  displayName: "LoongBoard",
  githubOwner: "acme",
  githubName: "project",
  localPath: "/tmp/project",
  remoteName: "origin",
  defaultBranch: "main",
  worktreeSlots: 1,
  enabled: true,
};

function json(value: unknown) {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function mockActivity() {
  const today = new Date().toISOString().slice(0, 10);
  const fetchMock = vi.fn<typeof fetch>(async (input) => {
    const url = new URL(String(input), "http://localhost");
    if (url.pathname === "/api/repositories")
      return json({ items: [repository] });
    if (url.pathname.endsWith("/pulls/activity-days")) {
      const from = url.searchParams.get("from");
      const to = url.searchParams.get("to");
      return json({
        days: [
          { date: today, count: 2 },
          { date: from ?? today, count: 0 },
          { date: to ?? today, count: 0 },
        ],
        calendarTimeZone: "Asia/Shanghai",
      });
    }
    if (url.pathname.endsWith("/issues/activity-days")) {
      return json({
        days: [{ date: today, count: 1 }],
        calendarTimeZone: "Asia/Shanghai",
      });
    }
    return json({ error: { code: "INTERNAL_ERROR", message: "not found" } });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function renderApp(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <App />
    </MemoryRouter>,
  );
}

describe("Repository activity page", () => {
  afterEach(() => {
    cleanup();
    appQueryClient.clear();
    vi.unstubAllGlobals();
  });

  it("shows one range calendar with range counts and list links", async () => {
    mockActivity();
    renderApp("/repositories/repo");

    expect(
      await screen.findByRole("heading", { name: "Repository activity" }),
    ).toBeInTheDocument();
    const cards = await screen.findAllByRole("article");
    const pullCard = cards.find((card) => within(card).queryByText("Pull requests updated"));
    const issueCard = cards.find((card) => within(card).queryByText("Issues updated"));
    expect(within(pullCard as HTMLElement).getByText("2")).toBeInTheDocument();
    expect(within(issueCard as HTMLElement).getByText("1")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /Date range/ })).toHaveLength(1);
    expect(
      screen.getByRole("button", { name: /Timezone: Asia\/Shanghai/ }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "Day navigation" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Today" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Yesterday" })).not.toBeInTheDocument();
    const pullListLink = within(pullCard as HTMLElement).getByRole("link", {
      name: "Open list",
    });
    const issueListLink = within(issueCard as HTMLElement).getByRole("link", {
      name: "Open list",
    });
    expect(pullListLink).toHaveAttribute(
      "href",
      expect.stringMatching(/^\/repositories\/repo\/pulls\?from=[^&]+&to=[^&]+$/),
    );
    expect(issueListLink).toHaveAttribute(
      "href",
      expect.stringMatching(/^\/repositories\/repo\/issues\?from=[^&]+&to=[^&]+$/),
    );
    expect(pullListLink.getAttribute("href")).not.toContain("/api/");
    expect(issueListLink.getAttribute("href")).not.toContain("/api/");
  });
});
