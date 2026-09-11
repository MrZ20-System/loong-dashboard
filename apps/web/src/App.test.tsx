import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
  mergedPullRequestCount: 0,
};
const repositoryB = { ...repository, id: "repo-b", key: "repo-b", displayName: "LoongBoard B", githubName: "project-b" };

const pull = (number: number, title = `Pull ${number}`) => ({
  repositoryId: "repo", number, title, url: `https://github.com/acme/project/pull/${number}`,
  authorLogin: "author", status: "open" as const, updatedAt: "2026-09-03T02:03:04.000Z",
  changedFilesCount: 0, additions: 0, deletions: 0, domains: [] as Array<{ id: string; name: string; color: string }>,
});

const issue = (number: number, title = `Issue ${number}`) => ({
  repositoryId: "repo", number, title, url: `https://github.com/acme/project/issues/${number}`,
  authorLogin: "author", status: "open" as const, updatedAt: "2026-09-03T02:03:04.000Z", commentsCount: 0,
});

type StreamStatus = "idle" | "running" | "failed";
type SyncSnapshot = { pullRequests: StreamStatus; issues: StreamStatus };

const syncFixtureTimestamp = "2026-09-03T02:03:04.000Z";

const stream = (status: StreamStatus, entityKind: "pull_request" | "issue" = "pull_request", bootstrap = false) => ({
  entityKind, status,
  watermarkUpdatedAt: bootstrap ? null : syncFixtureTimestamp,
  lastAttemptAt: bootstrap ? null : syncFixtureTimestamp,
  lastSuccessAt: bootstrap ? null : syncFixtureTimestamp,
  lastError: status === "failed" ? "provider failed" : null,
  rateLimitRemaining: null, rateLimitResetAt: null,
});

const syncBody = (pullStatus: StreamStatus, issueStatus = pullStatus, repositoryId = "repo", bootstrap = false) => ({
  repositoryId,
  status: pullStatus === "running" || issueStatus === "running" ? "running" : pullStatus === "failed" || issueStatus === "failed" ? "failed" : "idle",
  pullRequests: stream(pullStatus, "pull_request", bootstrap), issues: stream(issueStatus, "issue", bootstrap),
});

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
}

function mockApi(options: { pulls?: unknown[]; issues?: unknown[]; pullPages?: unknown[][]; issuePages?: unknown[][]; mergedPages?: unknown[][]; pullsByRepository?: Record<string, unknown[][]>; syncStatuses?: StreamStatus[]; syncSnapshots?: SyncSnapshot[]; syncSnapshotsByRepository?: Record<string, SyncSnapshot[]>; syncDelayMs?: number; syncRunIds?: string[]; syncLookbackDays?: 7 | 30; bootstrapSync?: boolean; repositories?: typeof repository[]; onSyncStatusAbort?: (repositoryId: string) => void; domains?: unknown[]; reclassification?: { running: boolean; pendingCount: number | null }; onDomainMutation?: (method: string, url: string, body: unknown) => Response | undefined } = {}) {
  const pulls = options.pulls ?? [pull(2), pull(1)];
  const issues = options.issues ?? [issue(7)];
  let pullPage = 0;
  const pullPagesByRepository = new Map<string, number>();
  let issuePage = 0;
  let mergedPage = 0;
  let syncIndex = 0;
  const syncIndexesByRepository = new Map<string, number>();
  let syncRunIndex = 0;
  const pullPages = options.pullPages ?? [pulls];
  const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(String(input), "http://localhost");
    if (url.pathname === "/api/auth/status") return json({ enabled: false, unlocked: true });
    if (url.pathname === "/api/repositories") return json({ items: options.repositories ?? [repository] });
    if (/^\/api\/repositories\/[^/]+\/settings$/.test(url.pathname) && (init?.method ?? "GET") === "GET") {
      const repositoryId = url.pathname.split("/")[3] ?? "repo";
      return json({ repositoryId, automaticSync: true, syncFrequencyMinutes: 60, syncLookbackDays: options.syncLookbackDays ?? 30, nextSyncAt: null, lastSyncAt: null, lastError: null });
    }
    if (url.pathname.endsWith("/domains")) {
      const mutation = options.onDomainMutation?.(init?.method ?? "GET", url.pathname, init?.body ? JSON.parse(String(init.body)) : undefined);
      if (mutation) return mutation;
      return json({ items: options.domains ?? [], reclassification: options.reclassification ?? { running: false, pendingCount: null } });
    }
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
      return json(syncBody(snapshot.pullRequests, snapshot.issues, repositoryId, options.bootstrapSync === true));
    }
    if (url.pathname.endsWith("/pulls")) {
      const repositoryId = url.pathname.split("/")[3] ?? "repo";
      const repositoryPullPages = options.pullsByRepository?.[repositoryId] ?? pullPages;
      const requestedPage = Number(url.searchParams.get("page") ?? "");
      const pageIndex = Number.isInteger(requestedPage) && requestedPage > 1
        ? requestedPage - 1
        : options.pullsByRepository ? (pullPagesByRepository.get(repositoryId) ?? 0) : pullPage;
      const query = url.searchParams.get("search")?.trim().toLowerCase() ?? "";
      const allItems = repositoryPullPages.flat();
      const items = query
        ? allItems.filter((item) => {
            const row = item as { number: number; title: string; authorLogin: string | null };
            const numberQuery = query.startsWith("#") ? query.slice(1) : query;
            return String(row.number).includes(numberQuery) || row.title.toLowerCase().includes(query) || row.authorLogin?.toLowerCase().includes(query) === true;
          })
        : repositoryPullPages[Math.min(pageIndex, repositoryPullPages.length - 1)];
      if (options.pullsByRepository) pullPagesByRepository.set(repositoryId, pageIndex + 1);
      else pullPage += 1;
      return json({ items, page: pageIndex + 1, pageSize: 100, totalCount: query ? items.length : repositoryPullPages.flat().length, totalPages: query ? 1 : repositoryPullPages.length, calendarTimeZone: "Asia/Shanghai" });
    }
    if (url.pathname.endsWith("/issues")) {
      const issuePages = options.issuePages ?? [issues];
      const query = url.searchParams.get("search")?.trim().toLowerCase() ?? "";
      const cursor = url.searchParams.get("cursor");
      const pageIndex = cursor ? 1 : issuePage++;
      const pageItems = issuePages[Math.min(pageIndex, issuePages.length - 1)];
      const items = query
        ? issuePages.flat().filter((item) => {
            const row = item as { number: number; title: string; authorLogin: string | null };
            const numberQuery = query.startsWith("#") ? query.slice(1) : query;
            return String(row.number).includes(numberQuery) || row.title.toLowerCase().includes(query) || row.authorLogin?.toLowerCase().includes(query) === true;
          })
        : pageItems;
      return json({ items, nextCursor: query || cursor ? null : issuePages.length > 1 ? "issue-page-2" : null, calendarTimeZone: "Asia/Shanghai" });
    }
    if (url.pathname.endsWith("/merged")) {
      const pages = options.mergedPages ?? [[]];
      const requestedPage = Number(url.searchParams.get("page") ?? "");
      const pageIndex = Math.min(Number.isInteger(requestedPage) && requestedPage > 0 ? requestedPage - 1 : mergedPage++, pages.length - 1);
      return json({ items: pages[pageIndex], page: pageIndex + 1, pageSize: 100, totalCount: pages.flat().length, totalPages: pages.length, calendarTimeZone: "Asia/Shanghai" });
    }
    return json({ error: { code: "INTERNAL_ERROR", message: "not found" } }, 404);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function renderApp(path: string) {
  return render(<MemoryRouter initialEntries={[path]}><App /></MemoryRouter>);
}

function mainContent() {
  return within(screen.getByRole("main"));
}

function appSidebar() {
  return within(screen.getByRole("complementary", { name: "Primary" }));
}

function primaryNavigation() {
  return within(screen.getByRole("navigation", { name: "Primary navigation" }));
}

describe("LoongBoard metadata routes", () => {
  afterEach(() => {
    appQueryClient.clear();
    vi.unstubAllGlobals();
  });

  it("uses the Board selector as the only repository entry point and opens Activity", async () => {
    mockApi({ repositories: [repository, repositoryB] });
    renderApp("/");
    const selector = await screen.findByRole("combobox", { name: "Repository" });
    expect(mainContent().queryByRole("link", { name: "Open Pull Requests" })).not.toBeInTheDocument();
    expect(mainContent().queryByRole("link", { name: "Open Issues" })).not.toBeInTheDocument();
    fireEvent.change(selector, { target: { value: "repo-b" } });
    expect(await screen.findByRole("heading", { name: "Repository activity" })).toBeInTheDocument();
  });

  it("renders a PR route without duplicated repository sibling navigation", async () => {
    mockApi();
    renderApp("/repositories/repo/pulls?from=2026-09-03&to=2026-09-03&status=merged&cursor=stale");
    expect(await screen.findByRole("heading", { name: "Pull requests" })).toBeInTheDocument();
    expect(mainContent().queryByRole("navigation", { name: "Repository metadata navigation" })).not.toBeInTheDocument();
    expect(mainContent().queryByRole("link", { name: "Issues" })).not.toBeInTheDocument();
    expect(primaryNavigation().getByRole("link", { name: "Issues" })).toHaveAttribute("href", "/repositories/repo/issues");
    const feed = await screen.findByRole("list", { name: "Pull request feed" });
    const pullRow = within(feed).getByRole("link", {
      name: "Pull request #2: Pull 2",
    });
    expect(pullRow).toHaveAttribute("tabindex", "0");
    expect(within(pullRow).queryByRole("link", { name: "Pull 2" })).not.toBeInTheDocument();
    expect(
      within(pullRow).getByRole("link", {
        name: "Open pull request #2 on GitHub",
      }),
    ).toHaveAttribute("href", "https://github.com/acme/project/pull/2");
    expect(within(pullRow).queryByRole("link", { name: "Open GitHub" })).not.toBeInTheDocument();
    fireEvent.click(pullRow);
    expect(await screen.findByRole("heading", { name: "Pull request unavailable" })).toBeInTheDocument();
  });

  it("renders the independent Merged projection with repository navigation and context", async () => {
    const merged = { ...pull(42, "Merged scheduler fix"), mergedAt: "2026-09-10T08:30:00.000Z", status: "merged" as const };
    mockApi({ mergedPages: [[merged]] });
    renderApp("/repositories/repo/merged");
    expect(await screen.findByRole("heading", { name: "Merged" })).toBeInTheDocument();
    expect(screen.getByText("Merged scheduler fix")).toBeInTheDocument();
    expect(primaryNavigation().getByRole("link", { name: /Merged/ })).toHaveAttribute("href", "/repositories/repo/merged");
    expect(screen.getByText(/LoongBoard · Merged/, { selector: ".topbar__context strong" })).toBeInTheDocument();
  });

  it("renders Issue fields without the redundant summary metrics row", async () => {
    mockApi({ issues: [issue(7, "A tracked issue")] });
    renderApp("/repositories/repo/issues");
    expect(await screen.findByRole("heading", { name: "Issues" })).toBeInTheDocument();
    const feed = await screen.findByRole("list", { name: "Issue feed" });
    const issueRow = within(feed).getByRole("link", {
      name: "Issue #7: A tracked issue",
    });
    expect(issueRow).toHaveAttribute("tabindex", "0");
    expect(within(issueRow).queryByRole("link", { name: "A tracked issue" })).not.toBeInTheDocument();
    expect(
      within(issueRow).getByRole("link", {
        name: "Open issue #7 on GitHub",
      }),
    ).toHaveAttribute("href", "https://github.com/acme/project/issues/7");
    expect(within(issueRow).queryByRole("link", { name: "Open" })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("List metrics")).not.toBeInTheDocument();
    fireEvent.click(issueRow);
    expect(await screen.findByRole("heading", { name: "Issue unavailable" })).toBeInTheDocument();
  });

  it("searches issues by number substring, author, or contiguous title", async () => {
    mockApi({
      issues: [
        { ...issue(7, "Track scheduler latency"), authorLogin: "IssueOwner" },
        { ...issue(80, "Unrelated report"), authorLogin: "someone-else" },
      ],
    });
    renderApp("/repositories/repo/issues");
    const search = await screen.findByRole("searchbox", { name: "Search list" });
    expect(search).toHaveAttribute(
      "placeholder",
      "Issue number, author, or title",
    );

    fireEvent.change(search, { target: { value: "7" } });
    await waitFor(() => {
      expect(screen.getByText("Track scheduler latency")).toBeInTheDocument();
      expect(screen.queryByText("Unrelated report")).not.toBeInTheDocument();
    });

    fireEvent.change(search, { target: { value: "#7" } });
    await waitFor(() => {
      expect(screen.getByText("Track scheduler latency")).toBeInTheDocument();
      expect(screen.queryByText("Unrelated report")).not.toBeInTheDocument();
    });

    fireEvent.change(search, { target: { value: "issueowner" } });
    await waitFor(() => expect(screen.getByText("Track scheduler latency")).toBeInTheDocument());

    fireEvent.change(search, { target: { value: "scheduler latency" } });
    await waitFor(() => expect(screen.getByText("Track scheduler latency")).toBeInTheDocument());

    fireEvent.change(search, { target: { value: "scheduler track" } });
    await waitFor(() => expect(screen.queryByText("Track scheduler latency")).not.toBeInTheDocument());
  });

  it("searches pull requests by number substring, author, or contiguous title", async () => {
    mockApi({
      pulls: [
        { ...pull(53_906, "Add GLM flash support"), authorLogin: "ZJY0516" },
        { ...pull(5_912, "Unrelated change"), authorLogin: "someone-else" },
      ],
    });
    renderApp("/repositories/repo/pulls");
    const search = await screen.findByRole("searchbox", { name: "Search list" });

    fireEvent.change(search, { target: { value: "53906" } });
    await waitFor(() => {
      expect(screen.getByText("Add GLM flash support")).toBeInTheDocument();
      expect(screen.queryByText("Unrelated change")).not.toBeInTheDocument();
    });

    fireEvent.change(search, { target: { value: "#390" } });
    await waitFor(() => {
      expect(screen.getByText("Add GLM flash support")).toBeInTheDocument();
      expect(screen.queryByText("Unrelated change")).not.toBeInTheDocument();
    });

    fireEvent.change(search, { target: { value: "zjy0516" } });
    await waitFor(() => expect(screen.getByText("Add GLM flash support")).toBeInTheDocument());

    fireEvent.change(search, { target: { value: "GLM flash" } });
    await waitFor(() => expect(screen.getByText("Add GLM flash support")).toBeInTheDocument());

    fireEvent.change(search, { target: { value: "GLM support" } });
    await waitFor(() => expect(screen.queryByText("Add GLM flash support")).not.toBeInTheDocument());
  });

  it("sanitizes invalid URL filters and resets cursor", async () => {
    const fetchMock = mockApi();
    renderApp("/repositories/repo/pulls?date=2026-02-29&status=nope&cursor=stale");
    await screen.findByRole("heading", { name: "Pull requests" });
    await waitFor(() => expect(fetchMock.mock.calls.some(([input]) => {
      const url = new URL(String(input), "http://localhost");
      return url.pathname === "/api/repositories/repo/pulls" && !url.searchParams.has("date") && !url.searchParams.has("status") && !url.searchParams.has("cursor");
    })).toBe(true));
  });

  it("keeps legacy date URLs compatible while requesting from/to", async () => {
    const fetchMock = mockApi();
    renderApp("/repositories/repo/pulls?date=2026-09-03&cursor=stale");
    await screen.findByRole("heading", { name: "Pull requests" });
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(
          ([input]) =>
            String(input).includes(
              "/api/repositories/repo/pulls?from=2026-09-03&to=2026-09-03",
            ),
        ),
      ).toBe(true),
    );
  });

  it("keeps Server order, paginates, and preserves stored status", async () => {
    const rows = [pull(9), { ...pull(8), status: "merged" as const }];
    mockApi({ pullPages: [[rows[0]], [rows[1]]] });
    renderApp("/repositories/repo/pulls");
    expect(await screen.findByText("Pull 9")).toBeInTheDocument();
    expect(screen.getAllByText("open").some((element) => element.closest(".feed-row") !== null)).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(await screen.findByText("Pull 8")).toBeInTheDocument();
    expect(screen.getAllByText("merged").some((element) => element.closest(".feed-row") !== null)).toBe(true);
  });

  it("refreshes metadata after an accepted sync that is immediately idle", async () => {
    const fetchMock = mockApi({ syncStatuses: ["idle", "idle"] });
    renderApp("/repositories/repo/pulls");
    await screen.findByText("Pull 2");
    const before = fetchMock.mock.calls.filter(([input]) => String(input).includes("/pulls")).length;
    const repositoriesBefore = fetchMock.mock.calls.filter(([input]) => String(input) === "/api/repositories").length;
    fireEvent.click(screen.getByRole("button", { name: "Sync now" }));
    await waitFor(() => expect(fetchMock.mock.calls.filter(([input]) => String(input).includes("/pulls")).length).toBeGreaterThan(before));
    await waitFor(() => expect(fetchMock.mock.calls.filter(([input]) => String(input) === "/api/repositories").length).toBeGreaterThan(repositoriesBefore));
  });

  it("labels a repository with no stream watermarks as an initial sync", async () => {
    mockApi({ syncStatuses: ["running"], syncLookbackDays: 7, bootstrapSync: true });
    renderApp("/repositories/repo/pulls");
    expect(await screen.findByText("Initial sync · last 7 days")).toBeInTheDocument();
  });

  it("refreshes metadata after running becomes idle and keeps rows on failed sync", async () => {
    const fetchMock = mockApi({ syncStatuses: ["idle", "running", "idle"] });
    renderApp("/repositories/repo/pulls");
    await screen.findByText("Pull 2");
    fireEvent.click(screen.getByRole("button", { name: "Sync now" }));
    await waitFor(() => expect(fetchMock.mock.calls.filter(([input]) => String(input).includes("/pulls")).length).toBeGreaterThan(1), { timeout: 3_000 });
    cleanup();
    appQueryClient.clear();
    const failedFetch = mockApi({ syncStatuses: ["failed"], bootstrapSync: true });
    renderApp("/repositories/repo/pulls");
    await screen.findByText("Pull 2");
    fireEvent.click(screen.getByRole("button", { name: "Sync now" }));
    expect(await screen.findByText("Initial sync failed · last 30 days")).toBeInTheDocument();
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
    appQueryClient.setQueryData(["metadata", "repo", "issues", "updated", ":::current::", 1, null], {
      items: [oldIssue], page: 1, pageSize: 100, totalCount: 1, totalPages: 1, calendarTimeZone: "Asia/Shanghai",
    });
    renderApp("/repositories/repo/pulls");
    expect(await screen.findByText("Old pull")).toBeInTheDocument();
    expect(await screen.findByText("Sync idle")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Sync now" }));
    expect(await screen.findByText("Synced pull", {}, { timeout: 4_000 })).toBeInTheDocument();
    expect(fetchMock.mock.calls.filter(([input]) => String(input).includes("/issues")).length).toBe(0);
    fireEvent.click(primaryNavigation().getByRole("link", { name: "Issues" }));
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
    appQueryClient.setQueryData(["metadata", "repo", "pulls", "updated", ":::current::", 1, null], {
      items: [oldPull], page: 1, pageSize: 100, totalCount: 1, totalPages: 1, calendarTimeZone: "Asia/Shanghai",
    });
    renderApp("/repositories/repo/issues");
    expect(await screen.findByText("Old issue")).toBeInTheDocument();
    expect(await screen.findByText("Sync idle")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Sync now" }));
    expect(await screen.findByText("Synced issue", {}, { timeout: 4_000 })).toBeInTheDocument();
    fireEvent.click(primaryNavigation().getByRole("link", { name: "Pull requests" }));
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
    appQueryClient.setQueryData(["metadata", "repo", "issues", "updated", ":::current::", 1, null], {
      items: [oldIssue], page: 1, pageSize: 100, totalCount: 1, totalPages: 1, calendarTimeZone: "Asia/Shanghai",
    });
    renderApp("/repositories/repo/pulls");
    expect(await screen.findByText("Old pull")).toBeInTheDocument();
    expect(await screen.findByText("Sync idle")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Sync now" }));
    expect(await screen.findByText("Delayed synced pull", {}, { timeout: 4_000 })).toBeInTheDocument();
    expect(await screen.findByText(/Last sync failed/, {}, { timeout: 4_000 })).toBeInTheDocument();
    const issueQuery = appQueryClient.getQueryCache().find({ queryKey: ["metadata", "repo", "issues", "updated", ":::current::", 1, null] });
    expect(issueQuery?.state.isInvalidated).toBe(false);
    expect(issueQuery?.state.data).toMatchObject({ items: [oldIssue] });
    fireEvent.click(primaryNavigation().getByRole("link", { name: "Issues" }));
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
    appQueryClient.setQueryData(["metadata", "repo", "pulls", "updated", ":::current::", 1, null], {
      items: [oldPull], page: 1, pageSize: 100, totalCount: 1, totalPages: 1, calendarTimeZone: "Asia/Shanghai",
    });
    renderApp("/repositories/repo/issues");
    expect(await screen.findByText("Old issue")).toBeInTheDocument();
    expect(await screen.findByText("Sync idle")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Sync now" }));
    expect(await screen.findByText("Delayed synced issue", {}, { timeout: 4_000 })).toBeInTheDocument();
    expect(await screen.findByText(/Last sync failed/, {}, { timeout: 4_000 })).toBeInTheDocument();
    const pullQuery = appQueryClient.getQueryCache().find({ queryKey: ["metadata", "repo", "pulls", "updated", ":::current::", 1, null] });
    expect(pullQuery?.state.isInvalidated).toBe(false);
    expect(pullQuery?.state.data).toMatchObject({ items: [oldPull] });
    fireEvent.click(primaryNavigation().getByRole("link", { name: "Pull requests" }));
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
    const nav = await screen.findByRole("navigation", { name: "Primary navigation" });
    expect(within(nav).getByRole("button", { name: /LoongBoard acme\/project/ })).toHaveAttribute("aria-expanded", "true");
    expect(within(nav).getByRole("button", { name: /LoongBoard B/ })).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(within(nav).getByRole("button", { name: /LoongBoard B/ }));
    const bSections = within(nav).getByRole("navigation", {
      name: "LoongBoard B sections",
    });
    fireEvent.click(within(bSections).getByRole("link", { name: "Pull requests" }));
    await waitFor(() => expect(abortedSyncStatusRepositories).toEqual(["repo"]));
    expect(await screen.findByText("B pull")).toBeInTheDocument();
    expect(within(nav).getByRole("button", { name: /LoongBoard acme\/project/ })).toHaveAttribute("aria-expanded", "true");
    expect(within(nav).getByRole("button", { name: /LoongBoard B/ })).toHaveAttribute("aria-expanded", "true");
    const aSections = within(nav).getByRole("navigation", {
      name: "LoongBoard sections",
    });
    fireEvent.click(within(aSections).getByRole("link", { name: "Pull requests" }));
    expect(await screen.findByText("A synced pull", {}, { timeout: 4_000 })).toBeInTheDocument();
    expect(screen.queryByText("A synced pull")).toBeInTheDocument();
    expect(fetchMock.mock.calls.filter(([input]) => String(input).includes("/repositories/repo/pulls")).length).toBe(2);
    expect(fetchMock.mock.calls.filter(([input]) => String(input).includes("/repositories/repo-b/pulls")).length).toBe(1);
    expect(abortedSyncStatusRepositories.filter((repositoryId) => repositoryId === "repo")).toHaveLength(1);
  });
});

describe("LoongBoard app shell", () => {
  afterEach(() => {
    appQueryClient.clear();
    vi.unstubAllGlobals();
  });

  it("groups workspace and repository routes with the active repository expanded", async () => {
    mockApi({ repositories: [repository, repositoryB] });
    renderApp("/repositories/repo/issues");
    const nav = await screen.findByRole("navigation", { name: "Primary navigation" });
    expect(within(nav).getByRole("link", { name: "Board" })).toHaveAttribute("href", "/");
    expect(within(nav).getByRole("link", { name: "Knowledge" })).toHaveAttribute("href", "/knowledge");
    const repoNav = await within(nav).findByRole("navigation", { name: "LoongBoard sections" });
    expect(within(repoNav).getByRole("link", { name: "Activity" })).toHaveAttribute("href", "/repositories/repo");
    expect(within(repoNav).getByRole("link", { name: "Pull requests" })).toHaveAttribute("href", "/repositories/repo/pulls");
    expect(within(repoNav).getByRole("link", { name: "Issues" })).toHaveAttribute("aria-current", "page");
    expect(within(nav).getByRole("button", { name: /LoongBoard acme\/project/ })).toHaveAttribute("aria-expanded", "true");
    expect(within(nav).getByRole("button", { name: /LoongBoard B/ })).toHaveAttribute("aria-expanded", "false");
    const settingsLink = appSidebar().getByRole("link", { name: "Settings" });
    expect(settingsLink).toHaveAttribute("href", "/settings");
    expect(appSidebar().queryByRole("navigation", { name: "Settings sections" })).not.toBeInTheDocument();
  });

  it("enters Settings through one direct footer link", async () => {
    mockApi();
    renderApp("/");
    const settingsLink = await screen.findByRole("link", { name: "Settings" });
    expect(settingsLink).toHaveAttribute("href", "/settings");
    expect(settingsLink).not.toHaveAttribute("aria-expanded");
    expect(appSidebar().queryByRole("navigation", { name: "Settings sections" })).not.toBeInTheDocument();
    fireEvent.click(settingsLink);
    expect(await screen.findByRole("heading", { name: "LoongBoard settings" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Settings" })).toHaveClass("sidebar-settings__trigger--active");
  });

  it("marks direct Settings active and closes the mobile drawer", async () => {
    mockApi();
    renderApp("/");
    fireEvent.click(await screen.findByRole("button", { name: "Open navigation" }));
    fireEvent.click(appSidebar().getByRole("link", { name: "Settings" }));
    expect(
      await screen.findByRole("heading", { name: "LoongBoard settings" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Settings" })).toHaveClass("sidebar-settings__trigger--active");
    expect(appSidebar().queryByRole("navigation", { name: "Settings sections" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open navigation" })).toHaveAttribute("aria-expanded", "false");
  });

  it("shows repository context and sync action in the contextual topbar", async () => {
    mockApi();
    renderApp("/repositories/repo/pulls");
    expect(await screen.findByText("Pull 2")).toBeInTheDocument();
    const banner = await screen.findByRole("banner");
    expect(within(banner).getByText("acme/project")).toBeInTheDocument();
    expect(
      within(banner).getByText("LoongBoard · Pull requests"),
    ).toBeInTheDocument();
    expect(await within(banner).findByText("Sync idle")).toBeInTheDocument();
    expect(
      within(banner).getByRole("button", { name: "Sync now" }),
    ).toBeInTheDocument();
  });

  it("redirects the legacy health route into Settings > Health", async () => {
    mockApi();
    renderApp("/health");
    expect(
      await screen.findByRole("heading", { name: "LoongBoard settings" }),
    ).toBeInTheDocument();
    expect(
      await screen.findByRole("heading", { name: "Service health" }),
    ).toBeInTheDocument();
  });

  it("lists PR rows as an accessible community-style feed", async () => {
    mockApi();
    renderApp("/repositories/repo/pulls");
    const feed = await screen.findByRole("list", { name: "Pull request feed" });
    const pullRows = within(feed).getAllByRole("link", {
      name: /^Pull request #\d+: /,
    });
    expect(pullRows).toHaveLength(2);
    const pullRow = pullRows[0] as HTMLElement;
    expect(pullRow).toHaveAttribute("tabindex", "0");
    expect(within(pullRow).queryByRole("link", { name: "Pull 2" })).not.toBeInTheDocument();
    expect(
      within(pullRow).getByRole("link", {
        name: "Open pull request #2 on GitHub",
      }),
    ).toHaveAttribute("href", "https://github.com/acme/project/pull/2");
    expect(within(pullRow).queryByRole("link", { name: "Open GitHub" })).not.toBeInTheDocument();
    expect(within(feed).getAllByText("open").some((element) => element.closest(".status-pill") !== null)).toBe(true);
    fireEvent.click(pullRow);
    expect(await screen.findByRole("heading", { name: "Pull request unavailable" })).toBeInTheDocument();
  });

  it("switches the shell theme from the default light tokens", async () => {
    mockApi();
    renderApp("/");
    const shell = await waitFor(() => {
      const element = document.querySelector(".app-shell");
      if (element === null) throw new Error("App shell is not mounted");
      return element;
    });
    expect(shell).toHaveAttribute("data-theme", "light");
    fireEvent.click(screen.getByRole("button", { name: "Dark" }));
    expect(shell).toHaveAttribute("data-theme", "dark");
    expect(screen.getByRole("button", { name: "Dark" })).toHaveAttribute("aria-pressed", "true");
  });

  it("retains the app chrome on non-PR repository routes", async () => {
    mockApi();
    renderApp("/repositories/repo/issues");
    expect(await screen.findByRole("heading", { name: "Issues" })).toBeInTheDocument();
    expect(screen.getByRole("navigation", { name: "Primary navigation" })).toBeInTheDocument();
    expect(screen.getByRole("banner")).toBeInTheDocument();
    expect(screen.getByText("LoongBoard · local-first engineering workspace")).toBeInTheDocument();
    expect(document.querySelector(".app-shell")).not.toHaveClass("app-shell--pr-focus");
  });
});
