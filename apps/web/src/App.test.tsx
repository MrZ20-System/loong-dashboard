import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App, appQueryClient } from "./App";

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

const pull = (number: number, title = `Pull ${number}`) => ({
  repositoryId: "repo", number, title, url: `https://github.com/acme/project/pull/${number}`,
  authorLogin: "author", status: "open" as const, updatedAt: "2026-09-03T02:03:04.000Z",
  changedFilesCount: 0, additions: 0, deletions: 0,
});

const issue = (number: number, title = `Issue ${number}`) => ({
  repositoryId: "repo", number, title, url: `https://github.com/acme/project/issues/${number}`,
  authorLogin: "author", status: "open" as const, updatedAt: "2026-09-03T02:03:04.000Z", commentsCount: 0,
});

type StreamStatus = "idle" | "running" | "failed";
type SyncSnapshot = { pullRequests: StreamStatus; issues: StreamStatus };

const stream = (status: StreamStatus, entityKind: "pull_request" | "issue" = "pull_request") => ({
  entityKind, status, watermarkUpdatedAt: null, lastAttemptAt: null,
  lastSuccessAt: null, lastError: status === "failed" ? "provider failed" : null,
  rateLimitRemaining: null, rateLimitResetAt: null,
});

const syncBody = (pullStatus: StreamStatus, issueStatus = pullStatus) => ({
  repositoryId: "repo",
  status: pullStatus === "running" || issueStatus === "running" ? "running" : pullStatus === "failed" || issueStatus === "failed" ? "failed" : "idle",
  pullRequests: stream(pullStatus), issues: stream(issueStatus, "issue"),
});

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
}

function mockApi(options: { pulls?: unknown[]; issues?: unknown[]; pullPages?: unknown[][]; issuePages?: unknown[][]; syncStatuses?: StreamStatus[]; syncSnapshots?: SyncSnapshot[] } = {}) {
  const pulls = options.pulls ?? [pull(2), pull(1)];
  const issues = options.issues ?? [issue(7)];
  let pullPage = 0;
  let issuePage = 0;
  let syncIndex = 0;
  const pullPages = options.pullPages ?? [pulls];
  const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(String(input), "http://localhost");
    if (url.pathname === "/api/repositories") return json({ items: [repository] });
    if (url.pathname.endsWith("/sync") && init?.method === "POST") return json({ repositoryId: "repo", syncRunId: "run-1", status: "accepted" }, 202);
    if (url.pathname.endsWith("/sync-status")) {
      const snapshots = options.syncSnapshots ?? (options.syncStatuses ?? ["idle"]).map((status) => ({ pullRequests: status, issues: status }));
      const snapshot = snapshots[Math.min(syncIndex++, snapshots.length - 1)];
      return json(syncBody(snapshot.pullRequests, snapshot.issues));
    }
    if (url.pathname.endsWith("/pulls")) {
      const items = pullPages[Math.min(pullPage++, pullPages.length - 1)];
      return json({ items, nextCursor: pullPage < pullPages.length ? "next-page" : null, calendarTimeZone: "Asia/Shanghai" });
    }
    if (url.pathname.endsWith("/issues")) {
      const issuePages = options.issuePages ?? [issues];
      const items = issuePages[Math.min(issuePage++, issuePages.length - 1)];
      return json({ items, nextCursor: null, calendarTimeZone: "Asia/Shanghai" });
    }
    return json({ error: { code: "INTERNAL_ERROR", message: "not found" } }, 404);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function renderApp(path: string) {
  return render(<MemoryRouter initialEntries={[path]}><App /></MemoryRouter>);
}

describe("LoongBoard metadata routes", () => {
  afterEach(() => {
    appQueryClient.clear();
    vi.unstubAllGlobals();
  });

  it("offers open PR and Issue actions for one configured repository", async () => {
    mockApi();
    renderApp("/");
    expect(await screen.findByRole("link", { name: "Open Pull Requests" })).toHaveAttribute("href", "/repositories/repo/pulls");
    expect(screen.getByRole("link", { name: "Open Issues" })).toHaveAttribute("href", "/repositories/repo/issues");
  });

  it("renders a PR route and discoverable sibling Issue navigation", async () => {
    mockApi();
    renderApp("/repositories/repo/pulls?date=2026-09-03&status=merged&cursor=stale");
    expect(await screen.findByRole("heading", { name: "Pull requests" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Issues" })).toHaveAttribute("href", "/repositories/repo/issues?date=2026-09-03");
    expect(screen.getByRole("link", { name: "Pull 2" })).toHaveAttribute("href", "https://github.com/acme/project/pull/2");
  });

  it("renders Issue fields and zero-valued metrics", async () => {
    mockApi({ issues: [issue(7, "A tracked issue")] });
    renderApp("/repositories/repo/issues");
    expect(await screen.findByRole("heading", { name: "Issues" })).toBeInTheDocument();
    expect(screen.getByText("A tracked issue")).toBeInTheDocument();
    expect(screen.getAllByText("Comments")[0].nextElementSibling).toHaveTextContent("0");
    expect(screen.getByText("Line changes").nextElementSibling).toHaveTextContent("0");
  });

  it("sanitizes invalid URL filters and resets cursor", async () => {
    const fetchMock = mockApi();
    renderApp("/repositories/repo/pulls?date=2026-02-29&status=nope&cursor=stale");
    await screen.findByRole("heading", { name: "Pull requests" });
    await waitFor(() => expect(fetchMock.mock.calls.some(([input]) => String(input) === "/api/repositories/repo/pulls")).toBe(true));
  });

  it("keeps Server order, paginates, and preserves stored status", async () => {
    const rows = [pull(9), { ...pull(8), status: "merged" as const }];
    mockApi({ pullPages: [[rows[0]], [rows[1]]] });
    renderApp("/repositories/repo/pulls");
    expect(await screen.findByText("Pull 9")).toBeInTheDocument();
    expect(screen.getAllByText("open").some((element) => element.tagName === "TD")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Load more" }));
    expect(await screen.findByText("Pull 8")).toBeInTheDocument();
    expect(screen.getAllByText("merged").some((element) => element.tagName === "TD")).toBe(true);
  });

  it("refreshes metadata after an accepted sync that is immediately idle", async () => {
    const fetchMock = mockApi({ syncStatuses: ["idle", "idle"] });
    renderApp("/repositories/repo/pulls");
    await screen.findByText("Pull 2");
    const before = fetchMock.mock.calls.filter(([input]) => String(input).includes("/pulls")).length;
    fireEvent.click(screen.getByRole("button", { name: "Sync now" }));
    await waitFor(() => expect(fetchMock.mock.calls.filter(([input]) => String(input).includes("/pulls")).length).toBeGreaterThan(before));
  });

  it("refreshes metadata after running becomes idle and keeps rows on failed sync", async () => {
    const fetchMock = mockApi({ syncStatuses: ["idle", "running", "idle"] });
    renderApp("/repositories/repo/pulls");
    await screen.findByText("Pull 2");
    fireEvent.click(screen.getByRole("button", { name: "Sync now" }));
    await waitFor(() => expect(fetchMock.mock.calls.filter(([input]) => String(input).includes("/pulls")).length).toBeGreaterThan(1), { timeout: 3_000 });
    cleanup();
    appQueryClient.clear();
    const failedFetch = mockApi({ syncStatuses: ["failed"] });
    renderApp("/repositories/repo/pulls");
    await screen.findByText("Pull 2");
    fireEvent.click(screen.getByRole("button", { name: "Sync now" }));
    expect(await screen.findByText(/Last sync failed/)).toBeInTheDocument();
    expect(screen.getByText("Pull 2")).toBeInTheDocument();
    expect(failedFetch).toBeDefined();
  });

  it("refreshes successful PRs when Issues fail and preserves cached Issue rows", async () => {
    const oldPull = pull(2, "Old pull");
    const newPull = pull(3, "Synced pull");
    const oldIssue = issue(7, "Existing Issue");
    const fetchMock = mockApi({
      pullPages: [[oldPull], [newPull]],
      syncSnapshots: [
        { pullRequests: "idle", issues: "idle" },
        { pullRequests: "running", issues: "running" },
        { pullRequests: "idle", issues: "failed" },
      ],
    });
    appQueryClient.setQueryData(["metadata", "repo", "issues", ":", null], {
      pages: [{ items: [oldIssue], nextCursor: null, calendarTimeZone: "Asia/Shanghai" }],
      pageParams: [null],
    });
    renderApp("/repositories/repo/pulls");
    expect(await screen.findByText("Old pull")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Sync now" }));
    expect(await screen.findByText("Synced pull", {}, { timeout: 4_000 })).toBeInTheDocument();
    expect(fetchMock.mock.calls.filter(([input]) => String(input).includes("/issues")).length).toBe(0);
    fireEvent.click(screen.getByRole("link", { name: "Issues" }));
    expect(await screen.findByText("Existing Issue")).toBeInTheDocument();
    expect(fetchMock.mock.calls.filter(([input]) => String(input).includes("/issues")).length).toBe(0);
  });

  it("refreshes successful Issues when PRs fail and preserves cached PR rows", async () => {
    const oldPull = pull(2, "Existing pull");
    const oldIssue = issue(7, "Old issue");
    const newIssue = issue(8, "Synced issue");
    const fetchMock = mockApi({
      issuePages: [[oldIssue], [newIssue]],
      syncSnapshots: [
        { pullRequests: "idle", issues: "idle" },
        { pullRequests: "running", issues: "running" },
        { pullRequests: "failed", issues: "idle" },
      ],
    });
    appQueryClient.setQueryData(["metadata", "repo", "pulls", ":", null], {
      pages: [{ items: [oldPull], nextCursor: null, calendarTimeZone: "Asia/Shanghai" }],
      pageParams: [null],
    });
    renderApp("/repositories/repo/issues");
    expect(await screen.findByText("Old issue")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Sync now" }));
    expect(await screen.findByText("Synced issue", {}, { timeout: 4_000 })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("link", { name: "Pull requests" }));
    expect(await screen.findByText("Existing pull")).toBeInTheDocument();
    expect(fetchMock.mock.calls.filter(([input]) => String(input).includes("/pulls")).length).toBe(0);
  });
});
