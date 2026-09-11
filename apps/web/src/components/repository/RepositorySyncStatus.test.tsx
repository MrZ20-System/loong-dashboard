import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RepositorySettings, SyncStatusResponse } from "@loongboard/contracts";

import { fetchSyncStatus, startSync } from "../../metadata-client";
import { fetchRepositorySettings } from "../../settings-client";
import { RepositorySyncStatus } from "./RepositorySyncStatus";

vi.mock("../../metadata-client", () => ({
  fetchSyncStatus: vi.fn(),
  startSync: vi.fn(),
}));

vi.mock("../../settings-client", () => ({
  fetchRepositorySettings: vi.fn(),
}));

const repositoryId = "repo";
const syncTimestamp = "2026-09-12T00:00:00.000Z";

function makeStatus({
  status = "idle",
  pullStatus = "idle",
  issueStatus = "idle",
  pullWatermark = syncTimestamp,
  issueWatermark = syncTimestamp,
  pullError = null,
  issueError = null,
  pullLastSuccessAt = syncTimestamp,
  issueLastSuccessAt = syncTimestamp,
}: {
  status?: "idle" | "running" | "failed";
  pullStatus?: "idle" | "running" | "failed";
  issueStatus?: "idle" | "running" | "failed";
  pullWatermark?: string | null;
  issueWatermark?: string | null;
  pullError?: string | null;
  issueError?: string | null;
  pullLastSuccessAt?: string | null;
  issueLastSuccessAt?: string | null;
} = {}): SyncStatusResponse {
  return {
    repositoryId,
    status,
    pullRequests: {
      entityKind: "pull_request",
      status: pullStatus,
      watermarkUpdatedAt: pullWatermark,
      lastAttemptAt: syncTimestamp,
      lastSuccessAt: pullLastSuccessAt,
      lastError: pullError,
      rateLimitRemaining: null,
      rateLimitResetAt: null,
    },
    issues: {
      entityKind: "issue",
      status: issueStatus,
      watermarkUpdatedAt: issueWatermark,
      lastAttemptAt: syncTimestamp,
      lastSuccessAt: issueLastSuccessAt,
      lastError: issueError,
      rateLimitRemaining: null,
      rateLimitResetAt: null,
    },
  };
}

function makeSettings(syncLookbackDays: 7 | 30): RepositorySettings {
  return {
    repositoryId,
    automaticSync: true,
    syncFrequencyMinutes: 60,
    syncLookbackDays,
    retention: {
      automaticArchiveEnabled: false,
      archiveAfterDays: 7,
      includeMergedPrs: true,
      includeClosedPrs: true,
      includeClosedIssues: true,
      prunePayloadWhenArchived: true,
    },
    worktrees: {
      configuredSlots: 1,
      idleCleanupTtlHours: 24,
      physicalSlots: 0,
      active: 0,
      idle: 0,
      dirty: 0,
      pendingRetirement: 0,
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

function createClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: Infinity },
      mutations: { retry: false },
    },
  });
}

function renderSync(client: QueryClient) {
  return render(
    <QueryClientProvider client={client}>
      <RepositorySyncStatus repositoryId={repositoryId} />
    </QueryClientProvider>,
  );
}

function metadataInvalidationKeys(client: QueryClient) {
  return vi
    .mocked(client.invalidateQueries)
    .mock.calls
    .map(([filters]) => filters?.queryKey)
    .filter((key): key is readonly unknown[] => key !== undefined)
    .filter((key) => key[0] === "metadata");
}

describe("RepositorySyncStatus", () => {
  beforeEach(() => {
    vi.mocked(fetchRepositorySettings).mockResolvedValue(makeSettings(30));
    vi.mocked(startSync).mockResolvedValue({
      repositoryId,
      syncRunId: "run-1",
      status: "accepted",
    });
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("waits for a fresh status response before invalidating both metadata streams", async () => {
    const client = createClient();
    const invalidateSpy = vi.spyOn(client, "invalidateQueries");
    const refresh = deferred<SyncStatusResponse>();
    const pullsKey = ["metadata", repositoryId, "pulls", "updated", ":::current::", 1, null];
    const issuesKey = ["metadata", repositoryId, "issues", "updated", ":::current::", 1, null];
    const pullRows = { items: [{ number: 1 }] };
    const issueRows = { items: [{ number: 2 }] };
    client.setQueryData(pullsKey, pullRows);
    client.setQueryData(issuesKey, issueRows);
    vi.mocked(fetchSyncStatus)
      .mockResolvedValueOnce(makeStatus())
      .mockReturnValueOnce(refresh.promise);

    renderSync(client);
    expect(await screen.findByText("Sync idle")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Sync now" }));
    await waitFor(() => expect(fetchSyncStatus).toHaveBeenCalledTimes(2));
    expect(invalidateSpy).not.toHaveBeenCalled();

    refresh.resolve(makeStatus());
    await waitFor(() => {
      expect(metadataInvalidationKeys(client)).toEqual([
        ["metadata", repositoryId, "pulls"],
        ["metadata", repositoryId, "issues"],
      ]);
    });
    expect(
      vi
        .mocked(client.invalidateQueries)
        .mock.calls.map(([filters]) => filters?.queryKey)
        .filter((key) => key?.[0] === "repositories"),
    ).toHaveLength(2);
    expect(client.getQueryData(pullsKey)).toEqual(pullRows);
    expect(client.getQueryData(issuesKey)).toEqual(issueRows);
  });

  it("invalidates only the successful stream and preserves cached rows when the other fails", async () => {
    const client = createClient();
    const invalidateSpy = vi.spyOn(client, "invalidateQueries");
    const refresh = deferred<SyncStatusResponse>();
    const pullsKey = ["metadata", repositoryId, "pulls", "updated", ":::current::", 1, null];
    const issuesKey = ["metadata", repositoryId, "issues", "updated", ":::current::", 1, null];
    const pullRows = { items: [{ number: 3 }] };
    const issueRows = { items: [{ number: 4 }] };
    client.setQueryData(pullsKey, pullRows);
    client.setQueryData(issuesKey, issueRows);
    vi.mocked(fetchSyncStatus)
      .mockResolvedValueOnce(makeStatus())
      .mockReturnValueOnce(refresh.promise);

    renderSync(client);
    expect(await screen.findByText("Sync idle")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Sync now" }));
    await waitFor(() => expect(fetchSyncStatus).toHaveBeenCalledTimes(2));

    refresh.resolve(
      makeStatus({
        status: "failed",
        issueStatus: "failed",
        issueError: "Issue stream failed",
        issueLastSuccessAt: null,
      }),
    );
    await waitFor(() => expect(metadataInvalidationKeys(client)).toEqual([
      ["metadata", repositoryId, "pulls"],
    ]));
    expect(
      metadataInvalidationKeys(client).some((key) => key[2] === "issues"),
    ).toBe(false);
    expect(client.getQueryData(pullsKey)).toEqual(pullRows);
    expect(client.getQueryData(issuesKey)).toEqual(issueRows);
    expect(screen.getByRole("alert")).toHaveTextContent("Last sync failed");
  });

  it("uses the configured lookback window for an initial sync", async () => {
    const client = createClient();
    vi.mocked(fetchRepositorySettings).mockResolvedValue(makeSettings(7));
    vi.mocked(fetchSyncStatus).mockResolvedValue(
      makeStatus({
        status: "running",
        pullStatus: "running",
        issueStatus: "running",
        pullWatermark: null,
        issueWatermark: null,
        pullLastSuccessAt: null,
        issueLastSuccessAt: null,
      }),
    );

    renderSync(client);

    expect(await screen.findByText("Initial sync · last 7 days")).toBeInTheDocument();
  });

  it("does not repeat one completion and resets handled state for the next accepted run", async () => {
    const client = createClient();
    const invalidateSpy = vi.spyOn(client, "invalidateQueries");
    const firstRefresh = deferred<SyncStatusResponse>();
    const secondRefresh = deferred<SyncStatusResponse>();
    let statusCall = 0;
    vi.mocked(fetchSyncStatus).mockImplementation(() => {
      statusCall += 1;
      if (statusCall === 1) return Promise.resolve(makeStatus({ status: "running", pullStatus: "running", issueStatus: "running" }));
      if (statusCall === 2) return firstRefresh.promise;
      return secondRefresh.promise;
    });
    vi.mocked(startSync)
      .mockResolvedValueOnce({ repositoryId, syncRunId: "run-1", status: "accepted" })
      .mockResolvedValueOnce({ repositoryId, syncRunId: "run-2", status: "accepted" });

    renderSync(client);
    expect(await screen.findByText("Syncing latest updates…")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Sync now" }));
    await waitFor(() => expect(fetchSyncStatus).toHaveBeenCalledTimes(2));
    firstRefresh.resolve(makeStatus());
    await waitFor(() => expect(metadataInvalidationKeys(client)).toHaveLength(2));
    expect(metadataInvalidationKeys(client)).toEqual([
      ["metadata", repositoryId, "pulls"],
      ["metadata", repositoryId, "issues"],
    ]);

    fireEvent.click(screen.getByRole("button", { name: "Sync now" }));
    await waitFor(() => expect(fetchSyncStatus).toHaveBeenCalledTimes(3));
    expect(metadataInvalidationKeys(client)).toHaveLength(2);
    secondRefresh.resolve(makeStatus());
    await waitFor(() => expect(metadataInvalidationKeys(client)).toHaveLength(4));
    expect(metadataInvalidationKeys(client)).toEqual([
      ["metadata", repositoryId, "pulls"],
      ["metadata", repositoryId, "issues"],
      ["metadata", repositoryId, "pulls"],
      ["metadata", repositoryId, "issues"],
    ]);
    expect(invalidateSpy).toHaveBeenCalled();
  });
});
