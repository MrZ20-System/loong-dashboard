import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HistorySyncSection } from "./features/settings/SettingsControlCenter";
import { PullRequestDetailPage } from "./pull-request-detail";
import { MemoryRouter, Route, Routes } from "react-router-dom";

vi.mock("./diff-viewer", () => ({
  DiffViewer: () => <div data-testid="mock-diff" />,
}));

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function queryClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

const baseHistory = {
  repositoryId: "repo",
  entityKind: "pull_request" as const,
  targetDate: "2026-08-01",
  oldestCoveredDay: "2026-08-20",
  cursor: null,
  enabled: false,
  status: "paused" as const,
  lastRunId: "old-run",
  lastError: null,
  updatedAt: "2026-09-10T00:00:00.000Z",
};

const run = {
  syncRunId: "old-run",
  repositoryId: "repo",
  kind: "history" as const,
  trigger: "api" as const,
  status: "completed" as const,
  requestedAt: "2026-09-10T00:00:00.000Z",
  startedAt: "2026-09-10T00:00:01.000Z",
  finishedAt: "2026-09-10T00:00:02.000Z",
  selector: { targetDate: "2026-08-01" },
  itemsSeen: 2,
  itemsWritten: 1,
  error: null,
  streams: [],
};

describe("sync history UI", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("continues a paused history run and polls only the accepted run", async () => {
    const calls: Array<{ path: string; method: string; body: string | undefined }> = [];
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(String(input), "http://localhost");
      calls.push({ path: url.pathname, method: init?.method ?? "GET", body: init?.body ? String(init.body) : undefined });
      if (url.pathname === "/api/repositories/repo/sync-history") {
        return json({ settings: [baseHistory, { ...baseHistory, entityKind: "issue" as const, status: "paused" }] });
      }
      if (url.pathname === "/api/repositories/repo/sync-runs") return json({ items: [run] });
      if (url.pathname === "/api/repositories/repo/sync-history/continue") return json({ repositoryId: "repo", syncRunId: "accepted-run", status: "accepted" }, 202);
      if (url.pathname === "/api/repositories/repo/sync-runs/accepted-run") return json({ ...run, syncRunId: "accepted-run", status: "running", finishedAt: null });
      return json({ error: { code: "INTERNAL_ERROR", message: "not found" } }, 404);
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = queryClient();
    render(<QueryClientProvider client={client}><HistorySyncSection repositoryId="repo" /></QueryClientProvider>);
    expect(await screen.findByRole("heading", { name: "Recent syncs" })).toBeInTheDocument();
    expect(await screen.findByText(/target 2026-08-01/)).toBeInTheDocument();
    expect(await screen.findByText(/started .* finished .* 1s/)).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: "Continue" })).toBeInTheDocument();
    expect(calls.some((call) => call.path.endsWith("/sync-runs/accepted-run"))).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await waitFor(() => expect(calls.some((call) => call.path.endsWith("/sync-history/continue") && call.method === "POST" && call.body === undefined)).toBe(true));
    await waitFor(() => expect(calls.some((call) => call.path.endsWith("/sync-runs/accepted-run"))).toBe(true));
    expect(await screen.findByText(/only this run is being checked/)).toBeInTheDocument();
    client.clear();
  });

  it("offers Fetch PR for a local miss and refreshes after the returned run completes", async () => {
    let available = false;
    const calls: string[] = [];
    const detail = {
      repositoryId: "repo",
      number: 5,
      title: "Fetched PR",
      url: "https://github.com/acme/project/pull/5",
      authorLogin: "author",
      status: "open",
      updatedAt: "2026-09-10T00:00:00.000Z",
      changedFilesCount: 0,
      additions: 0,
      deletions: 0,
      domains: [],
      createdAt: "2026-09-09T00:00:00.000Z",
      closedAt: null,
      mergedAt: null,
      baseRefName: "main",
      headRefName: "feature",
      headSha: "b".repeat(40),
      detailBody: null,
    };
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(String(input), "http://localhost");
      calls.push(`${init?.method ?? "GET"} ${url.pathname}`);
      if (url.pathname === "/api/repositories/repo/pulls/5/fetch") {
        available = true;
        return json({ repositoryId: "repo", syncRunId: "fetch-run", status: "accepted" }, 202);
      }
      if (url.pathname === "/api/repositories/repo/sync-runs/fetch-run") return json({ ...run, syncRunId: "fetch-run", kind: "fetch_pr", status: "completed" });
      if (url.pathname === "/api/repositories/repo/pulls/5") return available ? json(detail) : json({ error: { code: "NOT_FOUND", message: "Pull request is not available locally" } }, 404);
      if (url.pathname === "/api/repositories/repo/pulls/5/prepare") return json({ repositoryId: "repo", number: 5, headSha: "b".repeat(40), mergeBase: "a".repeat(40), fetched: false, files: [] });
      return json({ error: { code: "INTERNAL_ERROR", message: "not found" } }, 404);
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = queryClient();
    render(<MemoryRouter initialEntries={["/repositories/repo/pulls/5"]}><QueryClientProvider client={client}><Routes><Route path="/repositories/:repositoryId/pulls/:number" element={<PullRequestDetailPage />} /></Routes></QueryClientProvider></MemoryRouter>);
    expect(await screen.findByText("PR #5 isn't available locally.")).toBeInTheDocument();
    const unavailable = screen.getByRole("heading", { name: "Pull request unavailable" }).closest("section");
    expect(unavailable).toHaveClass("pr-detail", "pr-detail--focus", "pr-detail--unavailable");
    expect(unavailable?.querySelector(".pr-unavailable-card")).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Fetch PR" }));
    expect(await screen.findByRole("heading", { name: /Fetched PR/ })).toBeInTheDocument();
    expect(calls.filter((call) => call.includes("sync-runs/fetch-run")).length).toBeGreaterThan(0);
    client.clear();
  });
});
