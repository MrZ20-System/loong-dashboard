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
const repositoryB = { ...repository, id: "repo-b", key: "repo-b", displayName: "LoongBoard B", githubName: "project-b" };

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

const syncBody = (pullStatus: StreamStatus, issueStatus = pullStatus, repositoryId = "repo") => ({
  repositoryId,
  status: pullStatus === "running" || issueStatus === "running" ? "running" : pullStatus === "failed" || issueStatus === "failed" ? "failed" : "idle",
  pullRequests: stream(pullStatus), issues: stream(issueStatus, "issue"),
});

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
}

function mockApi(options: { pulls?: unknown[]; issues?: unknown[]; pullPages?: unknown[][]; issuePages?: unknown[][]; pullsByRepository?: Record<string, unknown[][]>; syncStatuses?: StreamStatus[]; syncSnapshots?: SyncSnapshot[]; syncSnapshotsByRepository?: Record<string, SyncSnapshot[]>; syncDelayMs?: number; syncRunIds?: string[]; repositories?: typeof repository[]; onSyncStatusAbort?: (repositoryId: string) => void } = {}) {
  const pulls = options.pulls ?? [pull(2), pull(1)];
  const issues = options.issues ?? [issue(7)];
  let pullPage = 0;
  const pullPagesByRepository = new Map<string, number>();
  let issuePage = 0;
  let syncIndex = 0;
  const syncIndexesByRepository = new Map<string, number>();
  let syncRunIndex = 0;
  const pullPages = options.pullPages ?? [pulls];
  const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(String(input), "http://localhost");
    if (url.pathname === "/api/repositories") return json({ items: options.repositories ?? [repository] });
    if (url.pathname.endsWith("/sync") && init?.method === "POST") {
      const repositoryId = url.pathname.split("/")[3] ?? "repo";
      const syncRunIds = options.syncRunIds ?? ["run-1"];
      const syncRunId = syncRunIds[Math.min(syncRunIndex++, syncRunIds.length - 1)];
      return json({ repositoryId, syncRunId, status: "accepted" }, 202);
    }
    if (url.pathname.endsWith("/sync-status")) {
      const repositoryId = url.pathname.split("/")[3] ?? "repo";
      if (options.syncDelayMs) {
        await new Promise<void>((resolve, reject) => {
          const signal = init?.signal;
          let timer: ReturnType<typeof setTimeout> | undefined;
          const cleanup = () => {
            if (timer !== undefined) clearTimeout(timer);
            signal?.removeEventListener("abort", onAbort);
          };
          const onAbort = () => {
            cleanup();
            options.onSyncStatusAbort?.(repositoryId);
            reject(new DOMException("The operation was aborted.", "AbortError"));
          };
          const onComplete = () => {
            cleanup();
            resolve();
          };
          if (signal?.aborted) {
            onAbort();
            return;
          }
          signal?.addEventListener("abort", onAbort, { once: true });
          timer = setTimeout(onComplete, options.syncDelayMs);
        });
      }
      const snapshots = options.syncSnapshotsByRepository?.[repositoryId] ?? options.syncSnapshots ?? (options.syncStatuses ?? ["idle"]).map((status) => ({ pullRequests: status, issues: status }));
      const nextIndex = options.syncSnapshotsByRepository ? (syncIndexesByRepository.get(repositoryId) ?? 0) : syncIndex;
      const snapshot = snapshots[Math.min(nextIndex, snapshots.length - 1)];
      if (options.syncSnapshotsByRepository) syncIndexesByRepository.set(repositoryId, nextIndex + 1);
      else syncIndex += 1;
      return json(syncBody(snapshot.pullRequests, snapshot.issues, repositoryId));
    }
    if (url.pathname.endsWith("/pulls")) {
      const repositoryId = url.pathname.split("/")[3] ?? "repo";
      const repositoryPullPages = options.pullsByRepository?.[repositoryId] ?? pullPages;
      const pageIndex = options.pullsByRepository ? (pullPagesByRepository.get(repositoryId) ?? 0) : pullPage;
      const items = repositoryPullPages[Math.min(pageIndex, repositoryPullPages.length - 1)];
      if (options.pullsByRepository) pullPagesByRepository.set(repositoryId, pageIndex + 1);
      else pullPage += 1;
      return json({ items, nextCursor: pageIndex + 1 < repositoryPullPages.length ? "next-page" : null, calendarTimeZone: "Asia/Shanghai" });
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
    expect(await screen.findByText("Sync idle")).toBeInTheDocument();
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
    expect(await screen.findByText("Sync idle")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Sync now" }));
    expect(await screen.findByText("Synced issue", {}, { timeout: 4_000 })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("link", { name: "Pull requests" }));
    expect(await screen.findByText("Existing pull")).toBeInTheDocument();
    expect(fetchMock.mock.calls.filter(([input]) => String(input).includes("/pulls")).length).toBe(0);
  });

  it("refreshes a directly idle PR while the Issue stream later fails", async () => {
    const oldPull = pull(2, "Old pull");
    const newPull = pull(3, "Delayed synced pull");
    const oldIssue = issue(7, "Existing Issue");
    mockApi({
      pullPages: [[oldPull], [newPull]],
      syncDelayMs: 20,
      syncSnapshots: [
        { pullRequests: "idle", issues: "idle" },
        { pullRequests: "idle", issues: "running" },
        { pullRequests: "idle", issues: "failed" },
      ],
    });
    appQueryClient.setQueryData(["metadata", "repo", "issues", ":", null], {
      pages: [{ items: [oldIssue], nextCursor: null, calendarTimeZone: "Asia/Shanghai" }],
      pageParams: [null],
    });
    renderApp("/repositories/repo/pulls");
    expect(await screen.findByText("Old pull")).toBeInTheDocument();
    expect(await screen.findByText("Sync idle")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Sync now" }));
    expect(await screen.findByText("Delayed synced pull", {}, { timeout: 4_000 })).toBeInTheDocument();
    expect(await screen.findByText(/Last sync failed/, {}, { timeout: 4_000 })).toBeInTheDocument();
    const issueQuery = appQueryClient.getQueryCache().find({ queryKey: ["metadata", "repo", "issues", ":", null] });
    expect(issueQuery?.state.isInvalidated).toBe(false);
    expect(issueQuery?.state.data).toMatchObject({ pages: [{ items: [oldIssue] }] });
    fireEvent.click(screen.getByRole("link", { name: "Issues" }));
    expect(await screen.findByText("Existing Issue")).toBeInTheDocument();
  });

  it("refreshes a directly idle Issue while the PR stream later fails", async () => {
    const oldPull = pull(2, "Existing pull");
    const oldIssue = issue(7, "Old issue");
    const newIssue = issue(8, "Delayed synced issue");
    mockApi({
      issuePages: [[oldIssue], [newIssue]],
      syncDelayMs: 20,
      syncSnapshots: [
        { pullRequests: "idle", issues: "idle" },
        { pullRequests: "running", issues: "idle" },
        { pullRequests: "failed", issues: "idle" },
      ],
    });
    appQueryClient.setQueryData(["metadata", "repo", "pulls", ":", null], {
      pages: [{ items: [oldPull], nextCursor: null, calendarTimeZone: "Asia/Shanghai" }],
      pageParams: [null],
    });
    renderApp("/repositories/repo/issues");
    expect(await screen.findByText("Old issue")).toBeInTheDocument();
    expect(await screen.findByText("Sync idle")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Sync now" }));
    expect(await screen.findByText("Delayed synced issue", {}, { timeout: 4_000 })).toBeInTheDocument();
    expect(await screen.findByText(/Last sync failed/, {}, { timeout: 4_000 })).toBeInTheDocument();
    const pullQuery = appQueryClient.getQueryCache().find({ queryKey: ["metadata", "repo", "pulls", ":", null] });
    expect(pullQuery?.state.isInvalidated).toBe(false);
    expect(pullQuery?.state.data).toMatchObject({ pages: [{ items: [oldPull] }] });
    fireEvent.click(screen.getByRole("link", { name: "Pull requests" }));
    expect(await screen.findByText("Existing pull")).toBeInTheDocument();
  });

  it("isolates metadata completion between consecutive sync attempts", async () => {
    const firstPull = pull(2, "First synced pull");
    const secondPull = pull(3, "Second synced pull");
    const fetchMock = mockApi({
      pullPages: [[pull(1, "Initial pull")], [firstPull], [secondPull]],
      syncRunIds: ["run-1", "run-2"],
      syncStatuses: ["idle", "running", "idle", "running", "idle"],
    });
    renderApp("/repositories/repo/pulls");
    expect(await screen.findByText("Initial pull")).toBeInTheDocument();
    expect(await screen.findByText("Sync idle")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Sync now" }));
    expect(await screen.findByText("First synced pull", {}, { timeout: 4_000 })).toBeInTheDocument();
    await waitFor(() => expect(fetchMock.mock.calls.filter(([input]) => String(input).includes("/sync-status")).length).toBeGreaterThanOrEqual(3), { timeout: 4_000 });
    fireEvent.click(screen.getByRole("button", { name: "Sync now" }));
    expect(await screen.findByText("Second synced pull", {}, { timeout: 4_000 })).toBeInTheDocument();
    expect(fetchMock.mock.calls.filter(([input]) => String(input).includes("/pulls")).length).toBe(3);
  });

  it("recovers an accepted sync after switching away and back", async () => {
    const initialPull = pull(1, "A initial pull");
    const syncedPull = pull(2, "A synced pull");
    const bPull = { ...pull(9, "B pull"), repositoryId: "repo-b", url: "https://github.com/acme/project-b/pull/9" };
    const abortedSyncStatusRepositories: string[] = [];
    const fetchMock = mockApi({
      repositories: [repository, repositoryB],
      syncDelayMs: 50,
      pullsByRepository: { repo: [[initialPull], [syncedPull]], "repo-b": [[bPull]] },
      syncSnapshotsByRepository: {
        repo: [
          { pullRequests: "idle", issues: "idle" },
          { pullRequests: "idle", issues: "idle" },
        ],
        "repo-b": [{ pullRequests: "idle", issues: "idle" }],
      },
      onSyncStatusAbort: (repositoryId) => abortedSyncStatusRepositories.push(repositoryId),
    });
    renderApp("/repositories/repo/pulls");
    expect(await screen.findByText("A initial pull")).toBeInTheDocument();
    expect(await screen.findByText("Sync idle")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Sync now" }));
    expect(await screen.findByText("Sync started.")).toBeInTheDocument();
    fireEvent.change(screen.getByRole("combobox", { name: "Repository" }), { target: { value: "repo-b" } });
    await waitFor(() => expect(abortedSyncStatusRepositories).toEqual(["repo"]));
    expect(await screen.findByText("B pull")).toBeInTheDocument();
    fireEvent.change(screen.getByRole("combobox", { name: "Repository" }), { target: { value: "repo" } });
    expect(await screen.findByText("A synced pull", {}, { timeout: 4_000 })).toBeInTheDocument();
    expect(screen.queryByText("A synced pull")).toBeInTheDocument();
    expect(fetchMock.mock.calls.filter(([input]) => String(input).includes("/repositories/repo/pulls")).length).toBe(2);
    expect(fetchMock.mock.calls.filter(([input]) => String(input).includes("/repositories/repo-b/pulls")).length).toBe(1);
    expect(abortedSyncStatusRepositories.filter((repositoryId) => repositoryId === "repo")).toHaveLength(1);
  });
});
