import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  completeSyncRunStream,
  createSyncRun,
  getSyncRun,
  getRepositoryHistoryState,
  getRepositorySyncState,
  listSyncRuns,
  listSyncRunTargets,
  markSyncRunStarted,
  openDatabase,
  reconcileRepositories,
  updateRepositoryHistoryState,
  type DatabaseClient,
} from "@loongboard/database";
import {
  RepositorySyncCoordinator,
  type RepositorySyncCoordinatorOptions,
} from "../src/sync-coordinator.js";
import type {
  FetchedIssueDetail,
  IssuePage,
  IssueSyncInput,
  PullRequestFilesInput,
  PullRequestFilesResult,
  PullRequestPage,
  PullRequestMetadata,
  PullRequestSyncInput,
  HistorySyncInput,
  GitHubMetadataProvider,
  IssueMetadata,
} from "@loongboard/github";
import { afterEach, describe, expect, it, vi } from "vitest";

const fixtures: Array<{ database: DatabaseClient; root: string }> = [];

afterEach(() => {
  for (const fixture of fixtures.splice(0)) {
    if (fixture.database.open) fixture.database.close();
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

function fixture(repositoryKeys: readonly string[] = ["vllm"]): DatabaseClient {
  const root = mkdtempSync(join(tmpdir(), "loongboard-sync-coordinator-"));
  const database = openDatabase(join(root, "state.sqlite3"));
  fixtures.push({ database, root });
  reconcileRepositories(database, repositoryKeys.map((key) => ({
    key,
    name: key === "vllm" ? "vLLM" : key,
    github: key === "vllm" ? "openai/vllm" : `openai/${key}`,
    path: join(root, key),
    remote: "origin",
    defaultBranch: "main",
    worktreeSlots: 1,
  })));
  return database;
}

function deferred<T = void>(): {
  promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolvePromise!: (value: T) => void;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
}

function providerFor(
  captures: { pull: PullRequestSyncInput | undefined; issue: IssueSyncInput | undefined },
): GitHubMetadataProvider {
  const rateLimit = { cost: 1, remaining: 4999, resetAt: "2026-09-10T00:00:00.000Z" };
  const pullPage: PullRequestPage = {
    items: [],
    pageInfo: { hasNextPage: false, endCursor: null },
    rateLimit,
  };
  const issuePage: IssuePage = {
    items: [],
    pageInfo: { hasNextPage: false, endCursor: null },
    rateLimit,
  };
  return {
    async *fetchPullRequestUpdates(input) {
      captures.pull = input;
      yield pullPage;
    },
    async *fetchIssueUpdates(input) {
      captures.issue = input;
      yield issuePage;
    },
    async fetchPullRequestFiles(
      _input: PullRequestFilesInput,
    ): Promise<PullRequestFilesResult[]> {
      return [];
    },
    async fetchIssueDetail(_input): Promise<FetchedIssueDetail> {
      throw new Error("not used");
    },
  };
}

describe("RepositorySyncCoordinator", () => {
  it("snapshots one configured initial window for both metadata streams", async () => {
    const database = fixture();
    const captures: {
      pull: PullRequestSyncInput | undefined;
      issue: IssueSyncInput | undefined;
    } = { pull: undefined, issue: undefined };
    const options: RepositorySyncCoordinatorOptions = {
      database,
      provider: providerFor(captures),
      lookbackDaysForRepository: () => 7,
      now: () => new Date("2026-09-09T10:00:00.000Z"),
    };
    const coordinator = new RepositorySyncCoordinator(options);

    coordinator.start("vllm");
    await coordinator.waitForIdle();

    expect(captures.pull).toMatchObject({ mode: "bootstrap", lookbackDays: 7 });
    expect(captures.issue).toMatchObject({ mode: "bootstrap", lookbackDays: 7 });
    await coordinator.close();
  });

  it("bounds history to one durable page batch and never backfills current PR state", async () => {
    const database = fixture();
    const captures: {
      pull: PullRequestSyncInput | undefined;
      issue: IssueSyncInput | undefined;
    } = { pull: undefined, issue: undefined };
    const historyInputs: { pull: unknown[]; issue: unknown[] } = { pull: [], issue: [] };
    const enriched: number[][] = [];
    const base = providerFor(captures);
    const provider: GitHubMetadataProvider = {
      ...base,
      async *fetchPullRequestHistory(input) {
        historyInputs.pull.push(input);
        yield {
          items: [
            pullRequestItem({ number: 10, updatedAt: "2026-09-01T00:00:00.000Z" }),
            pullRequestItem({
              number: 11,
              stateRaw: "MERGED",
              status: "merged",
              updatedAt: "2026-08-01T00:00:00.000Z",
              mergedAt: "2026-08-01T00:00:00.000Z",
            }),
          ],
          pageInfo: { hasNextPage: true, endCursor: "pull-next" },
          rateLimit: { cost: 1, remaining: 4999, resetAt: "2026-09-10T00:00:00.000Z" },
        };
        yield {
          items: [],
          pageInfo: { hasNextPage: false, endCursor: null },
          rateLimit: { cost: 1, remaining: 4998, resetAt: "2026-09-10T00:00:00.000Z" },
        };
      },
      async *fetchIssueHistory(input) {
        historyInputs.issue.push(input);
        yield {
          items: [issueItem({ number: 10 })],
          pageInfo: { hasNextPage: true, endCursor: "issue-next" },
          rateLimit: { cost: 1, remaining: 4999, resetAt: "2026-09-10T00:00:00.000Z" },
        };
        yield {
          items: [],
          pageInfo: { hasNextPage: false, endCursor: null },
          rateLimit: { cost: 1, remaining: 4998, resetAt: "2026-09-10T00:00:00.000Z" },
        };
      },
    };
    const coordinator = new RepositorySyncCoordinator({
      database,
      provider,
      historyPageBudget: 1,
      now: () => new Date("2026-09-10T10:00:00.000Z"),
      enricher: {
        async enrich(_repository, _rateLimit, targets) {
          enriched.push((targets ?? []).map((target) => target.number));
        },
      },
    });

    const run = coordinator.startHistory("vllm", { targetDate: "2026-07-01" });
    const completed = await coordinator.waitForRun(run.syncRunId);

    expect(completed).toMatchObject({ kind: "history", status: "partial" });
    expect(completed.streams).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ entityKind: "pull_request", status: "partial", itemsSeen: 2 }),
        expect.objectContaining({ entityKind: "issue", status: "partial", itemsSeen: 1 }),
      ]),
    );
    expect(historyInputs.pull[0]).toMatchObject({ cursor: null, recoveryAnchorUpdatedAt: null });
    expect(getRepositoryHistoryState(database, "vllm", "pull_request").cursor).toBe("pull-next");
    expect(getRepositoryHistoryState(database, "vllm", "issue").cursor).toBe("issue-next");
    expect(enriched).toEqual([]);
    expect(getRepositorySyncState(database, "vllm", "pull_request").watermarkUpdatedAt).toBeNull();
    await coordinator.close();
  });

  it("continues enabled history in bounded runs until the durable target", async () => {
    const database = fixture();
    const base = providerFor({ pull: undefined, issue: undefined });
    const pullInputs: HistorySyncInput[] = [];
    const issueInputs: HistorySyncInput[] = [];
    const rateLimit = { cost: 1, remaining: 4999, resetAt: "2026-09-10T00:00:00.000Z" };
    const provider: GitHubMetadataProvider = {
      ...base,
      async *fetchPullRequestHistory(input) {
        pullInputs.push(input);
        if (input.cursor === null) {
          yield {
            items: [pullRequestItem({ number: 101, updatedAt: "2026-09-01T00:00:00.000Z" })],
            pageInfo: { hasNextPage: true, endCursor: "pull-page-1" },
            rateLimit,
          };
          yield {
            items: [pullRequestItem({ number: 102, updatedAt: "2026-08-01T00:00:00.000Z" })],
            pageInfo: { hasNextPage: true, endCursor: "pull-page-2" },
            rateLimit,
          };
        } else {
          yield {
            items: [pullRequestItem({ number: 103, updatedAt: "2026-06-01T00:00:00.000Z" })],
            pageInfo: { hasNextPage: false, endCursor: null },
            rateLimit,
          };
        }
      },
      async *fetchIssueHistory(input) {
        issueInputs.push(input);
        if (input.cursor === null) {
          yield {
            items: [issueItem({ number: 201, updatedAt: "2026-09-01T00:00:00.000Z" })],
            pageInfo: { hasNextPage: true, endCursor: "issue-page-1" },
            rateLimit,
          };
          yield {
            items: [issueItem({ number: 202, updatedAt: "2026-08-01T00:00:00.000Z" })],
            pageInfo: { hasNextPage: true, endCursor: "issue-page-2" },
            rateLimit,
          };
        } else {
          yield {
            items: [issueItem({ number: 203, updatedAt: "2026-06-01T00:00:00.000Z" })],
            pageInfo: { hasNextPage: false, endCursor: null },
            rateLimit,
          };
        }
      },
    };
    const coordinator = new RepositorySyncCoordinator({
      database,
      provider,
      historyPageBudget: 2,
      now: () => new Date("2026-09-10T10:00:00.000Z"),
    });

    const firstRun = coordinator.startHistory("vllm", { targetDate: "2026-07-01" });
    const firstCompleted = await coordinator.waitForRun(firstRun.syncRunId);
    expect(firstCompleted.status).toBe("partial");
    await coordinator.waitForIdle();

    expect(pullInputs.map((input) => input.cursor)).toEqual([null, "pull-page-2"]);
    expect(issueInputs.map((input) => input.cursor)).toEqual([null, "issue-page-2"]);
    expect(getRepositoryHistoryState(database, "vllm", "pull_request")).toMatchObject({
      status: "completed",
      cursor: null,
      oldestCoveredDay: "2026-07-01",
    });
    expect(listSyncRuns(database, "vllm", 10).map((run) => run.status)).toEqual([
      "completed",
      "partial",
    ]);
    await coordinator.close();
  });

  it("resumes an enabled cursor left idle by an older partial run", async () => {
    const database = fixture();
    const partial = createSyncRun(database, {
      repositoryId: "vllm",
      kind: "history",
      trigger: "manual",
      entityKinds: ["pull_request", "issue"],
    });
    markSyncRunStarted(database, partial.syncRunId, "2026-09-10T09:00:00.000Z");
    for (const entityKind of ["pull_request", "issue"] as const) {
      completeSyncRunStream(database, partial.syncRunId, entityKind, {
        finishedAt: "2026-09-10T09:01:00.000Z",
        status: "partial",
      });
      updateRepositoryHistoryState(database, "vllm", entityKind, {
        enabled: true,
        status: "idle",
        targetDate: "2026-07-01",
        cursor: `${entityKind}-cursor`,
        recoveryAnchorUpdatedAt: "2026-08-01T00:00:00.000Z",
        lastRunId: partial.syncRunId,
      });
    }

    const pullInputs: HistorySyncInput[] = [];
    const issueInputs: HistorySyncInput[] = [];
    const base = providerFor({ pull: undefined, issue: undefined });
    const rateLimit = { cost: 1, remaining: 4999, resetAt: "2026-09-10T00:00:00.000Z" };
    const provider: GitHubMetadataProvider = {
      ...base,
      async *fetchPullRequestHistory(input) {
        pullInputs.push(input);
        yield { items: [], pageInfo: { hasNextPage: false, endCursor: null }, rateLimit };
      },
      async *fetchIssueHistory(input) {
        issueInputs.push(input);
        yield { items: [], pageInfo: { hasNextPage: false, endCursor: null }, rateLimit };
      },
    };
    const coordinator = new RepositorySyncCoordinator({ database, provider });

    coordinator.resumeEnabledHistories();
    await coordinator.waitForIdle();

    expect(pullInputs[0]?.cursor).toBe("pull_request-cursor");
    expect(issueInputs[0]?.cursor).toBe("issue-cursor");
    expect(getSyncRun(database, partial.syncRunId).status).toBe("partial");
    const statuses = listSyncRuns(database, "vllm", 10).map((run) => run.status);
    expect(statuses).toHaveLength(2);
    expect(statuses).toEqual(expect.arrayContaining(["completed", "partial"]));
    await coordinator.close();
  });

  it("admits a fresh bounded history run after restart without replaying the interrupted run", async () => {
    const root = mkdtempSync(join(tmpdir(), "loongboard-sync-restart-"));
    const path = join(root, "state.sqlite3");
    const first = openDatabase(path);
    fixtures.push({ database: first, root });
    reconcileRepositories(first, [
      {
        key: "vllm",
        name: "vLLM",
        github: "openai/vllm",
        path: join(root, "vllm"),
        remote: "origin",
        defaultBranch: "main",
        worktreeSlots: 1,
      },
    ]);
    const interrupted = createSyncRun(first, {
      repositoryId: "vllm",
      kind: "history",
      trigger: "manual",
      entityKinds: ["pull_request", "issue"],
    });
    markSyncRunStarted(first, interrupted.syncRunId, "2026-09-10T09:00:00.000Z");
    for (const entityKind of ["pull_request", "issue"] as const) {
      updateRepositoryHistoryState(first, "vllm", entityKind, {
        enabled: true,
        status: "running",
        targetDate: "2026-07-01",
        cursor: `${entityKind}-cursor`,
        recoveryAnchorUpdatedAt: "2026-08-01T00:00:00.000Z",
        lastRunId: interrupted.syncRunId,
      });
    }
    first.close();

    const reopened = openDatabase(path);
    fixtures.push({ database: reopened, root });
    const pullInputs: HistorySyncInput[] = [];
    const issueInputs: HistorySyncInput[] = [];
    const base = providerFor({ pull: undefined, issue: undefined });
    const emptyPullPage = (): PullRequestPage => ({
      items: [],
      pageInfo: { hasNextPage: false, endCursor: null },
      rateLimit: { cost: 1, remaining: 4999, resetAt: "2026-09-10T00:00:00.000Z" },
    });
    const emptyIssuePage = (): IssuePage => ({
      items: [],
      pageInfo: { hasNextPage: false, endCursor: null },
      rateLimit: { cost: 1, remaining: 4999, resetAt: "2026-09-10T00:00:00.000Z" },
    });
    const provider: GitHubMetadataProvider = {
      ...base,
      async *fetchPullRequestHistory(input) {
        pullInputs.push(input);
        yield emptyPullPage();
      },
      async *fetchIssueHistory(input) {
        issueInputs.push(input);
        yield emptyIssuePage();
      },
    };
    const coordinator = new RepositorySyncCoordinator({
      database: reopened,
      provider,
      now: () => new Date("2026-09-10T10:00:00.000Z"),
    });

    coordinator.resumeEnabledHistories();
    await coordinator.waitForIdle();

    expect(getSyncRun(reopened, interrupted.syncRunId).status).toBe("interrupted");
    expect(pullInputs[0]).toMatchObject({
      cursor: "pull_request-cursor",
      recoveryAnchorUpdatedAt: "2026-08-01T00:00:00.000Z",
    });
    expect(issueInputs[0]).toMatchObject({
      cursor: "issue-cursor",
      recoveryAnchorUpdatedAt: "2026-08-01T00:00:00.000Z",
    });
    expect(listSyncRuns(reopened, "vllm", 10).map((run) => run.status)).toEqual([
      "completed",
      "interrupted",
    ]);
    await coordinator.close();
  });

  it("fetches and enriches only one PR without changing forward watermarks", async () => {
    const database = fixture();
    const captures: {
      pull: PullRequestSyncInput | undefined;
      issue: IssueSyncInput | undefined;
    } = { pull: undefined, issue: undefined };
    const base = providerFor(captures);
    const item = pullRequestItem({ number: 27 });
    const provider: GitHubMetadataProvider = {
      ...base,
      async fetchPullRequest() {
        return item;
      },
    };
    const enriched: number[][] = [];
    const coordinator = new RepositorySyncCoordinator({
      database,
      provider,
      now: () => new Date("2026-09-10T10:00:00.000Z"),
      enricher: {
        async enrich(_repository, _rateLimit, targets) {
          enriched.push((targets ?? []).map((target) => target.number));
        },
      },
    });

    const run = coordinator.startFetchPullRequest("vllm", 27);
    const completed = await coordinator.waitForRun(run.syncRunId);

    expect(completed).toMatchObject({ kind: "fetch_pr", status: "completed" });
    expect(enriched).toEqual([[27]]);
    expect(getRepositorySyncState(database, "vllm", "pull_request").watermarkUpdatedAt).toBeNull();
    expect(listSyncRunTargets(database, run.syncRunId)).toEqual([
      expect.objectContaining({ number: 27, reason: "fetch_pr" }),
    ]);
    await coordinator.close();
  });

  it("queues a forward run behind active history without marking its state running", async () => {
    const database = fixture();
    const base = providerFor({ pull: undefined, issue: undefined });
    const historyStarted = deferred<void>();
    const releaseHistory = deferred<void>();
    const order: string[] = [];
    const forwardInputs: Array<PullRequestSyncInput | IssueSyncInput> = [];
    const clock = { value: new Date("2026-09-10T10:00:00.000Z") };
    const rateLimit = { cost: 1, remaining: 4999, resetAt: "2026-09-10T00:00:00.000Z" };
    const emptyPull = (): PullRequestPage => ({
      items: [],
      pageInfo: { hasNextPage: false, endCursor: null },
      rateLimit,
    });
    const emptyIssue = (): IssuePage => ({
      items: [],
      pageInfo: { hasNextPage: false, endCursor: null },
      rateLimit,
    });
    const provider: GitHubMetadataProvider = {
      ...base,
      async *fetchPullRequestHistory() {
        order.push("history:pull");
        historyStarted.resolve(undefined);
        await releaseHistory.promise;
        yield emptyPull();
      },
      async *fetchIssueHistory() {
        order.push("history:issue");
        await releaseHistory.promise;
        yield emptyIssue();
      },
      async *fetchPullRequestUpdates(input) {
        forwardInputs.push(input);
        order.push("forward:pull");
        yield emptyPull();
      },
      async *fetchIssueUpdates(input) {
        forwardInputs.push(input);
        order.push("forward:issue");
        yield emptyIssue();
      },
    };
    const coordinator = new RepositorySyncCoordinator({
      database,
      provider,
      now: () => clock.value,
    });

    const historyRun = coordinator.startHistory("vllm");
    await historyStarted.promise;
    const forwardRun = coordinator.start("vllm");

    expect(getSyncRun(database, forwardRun.syncRunId).status).toBe("queued");
    expect(getRepositorySyncState(database, "vllm", "pull_request").status).toBe("idle");
    clock.value = new Date("2026-09-10T10:05:00.000Z");
    releaseHistory.resolve(undefined);
    await coordinator.waitForRun(historyRun.syncRunId);
    await coordinator.waitForRun(forwardRun.syncRunId);

    expect(order).toEqual([
      "history:pull",
      "history:issue",
      "forward:pull",
      "forward:issue",
    ]);
    expect(forwardInputs.map((input) => input.syncStartedAt)).toEqual([
      "2026-09-10T10:05:00.000Z",
      "2026-09-10T10:05:00.000Z",
    ]);
    await coordinator.close();
  });

  it("keeps different PR fetches FIFO and rejects duplicate forward or PR requests", async () => {
    const database = fixture();
    const base = providerFor({ pull: undefined, issue: undefined });
    const firstStarted = deferred<void>();
    const releaseFirst = deferred<void>();
    const numbers: number[] = [];
    const provider: GitHubMetadataProvider = {
      ...base,
      async fetchPullRequest(input) {
        numbers.push(input.number);
        if (input.number === 1) {
          firstStarted.resolve(undefined);
          await releaseFirst.promise;
        }
        return pullRequestItem({ number: input.number });
      },
    };
    const coordinator = new RepositorySyncCoordinator({ database, provider });

    coordinator.startFetchPullRequest("vllm", 1);
    await firstStarted.promise;
    coordinator.startFetchPullRequest("vllm", 2);
    expect(() => coordinator.startFetchPullRequest("vllm", 2)).toThrowError(
      /A sync is already running for repository: vllm/,
    );
    expect(() => coordinator.startFetchPullRequest("vllm", 1)).toThrowError(
      /A sync is already running for repository: vllm/,
    );
    coordinator.start("vllm");
    expect(() => coordinator.start("vllm")).toThrowError(
      /A sync is already running for repository: vllm/,
    );

    releaseFirst.resolve(undefined);
    await coordinator.waitForIdle();
    expect(numbers).toEqual([1, 2]);
    await coordinator.close();
  });

  it("lets foreground work bypass and then preserve a history continuation timer", async () => {
    const database = fixture();
    const base = providerFor({ pull: undefined, issue: undefined });
    const order: string[] = [];
    let pullHistoryCalls = 0;
    let issueHistoryCalls = 0;
    const rateLimit = { cost: 1, remaining: 4999, resetAt: "2026-09-10T00:00:00.000Z" };
    const provider: GitHubMetadataProvider = {
      ...base,
      async *fetchPullRequestHistory() {
        pullHistoryCalls += 1;
        order.push(`history:pull:${pullHistoryCalls}`);
        if (pullHistoryCalls === 1) {
          yield {
            items: [pullRequestItem({ number: 31, updatedAt: "2026-09-01T00:00:00.000Z" })],
            pageInfo: { hasNextPage: true, endCursor: "next" },
            rateLimit,
          };
        } else {
          yield { items: [], pageInfo: { hasNextPage: false, endCursor: null }, rateLimit };
        }
      },
      async *fetchIssueHistory() {
        issueHistoryCalls += 1;
        order.push(`history:issue:${issueHistoryCalls}`);
        if (issueHistoryCalls === 1) {
          yield {
            items: [issueItem({ number: 31, updatedAt: "2026-09-01T00:00:00.000Z" })],
            pageInfo: { hasNextPage: true, endCursor: "next" },
            rateLimit,
          };
        } else {
          yield { items: [], pageInfo: { hasNextPage: false, endCursor: null }, rateLimit };
        }
      },
      async fetchPullRequest() {
        order.push("fetch:27");
        return pullRequestItem({ number: 27 });
      },
    };
    const coordinator = new RepositorySyncCoordinator({
      database,
      provider,
      historyPageBudget: 1,
    });

    const first = coordinator.startHistory("vllm", { targetDate: "2026-07-01" });
    await coordinator.waitForRun(first.syncRunId);
    coordinator.startFetchPullRequest("vllm", 27);
    await coordinator.waitForIdle();

    expect(order.indexOf("fetch:27")).toBeGreaterThan(-1);
    expect(order.indexOf("fetch:27")).toBeLessThan(order.indexOf("history:pull:2"));
    expect(pullHistoryCalls).toBe(2);
    expect(issueHistoryCalls).toBe(2);
    await coordinator.close();
  });

  it("persists a history rate-limit reset and re-admits exactly once after reset", async () => {
    vi.useFakeTimers();
    try {
      const database = fixture();
      const base = providerFor({ pull: undefined, issue: undefined });
      const now = { value: new Date("2026-09-10T10:00:00.000Z") };
      const pullInputs: HistorySyncInput[] = [];
      const issueInputs: HistorySyncInput[] = [];
      const resetAt = "2026-09-10T10:00:01.000Z";
      const provider: GitHubMetadataProvider = {
        ...base,
        async *fetchPullRequestHistory(input) {
          pullInputs.push(input);
          if (pullInputs.length === 1) {
            yield {
              items: [pullRequestItem({ number: 41, updatedAt: "2026-09-01T00:00:00.000Z" })],
              pageInfo: { hasNextPage: true, endCursor: "pull-reset" },
              rateLimit: { cost: 1, remaining: 199, resetAt },
            };
          } else {
            yield {
              items: [],
              pageInfo: { hasNextPage: false, endCursor: null },
              rateLimit: { cost: 1, remaining: 4999, resetAt },
            };
          }
        },
        async *fetchIssueHistory(input) {
          issueInputs.push(input);
          if (issueInputs.length === 1) {
            yield {
              items: [issueItem({ number: 41, updatedAt: "2026-09-01T00:00:00.000Z" })],
              pageInfo: { hasNextPage: true, endCursor: "issue-reset" },
              rateLimit: { cost: 1, remaining: 199, resetAt },
            };
          } else {
            yield {
              items: [],
              pageInfo: { hasNextPage: false, endCursor: null },
              rateLimit: { cost: 1, remaining: 4999, resetAt },
            };
          }
        },
      };
      const coordinator = new RepositorySyncCoordinator({
        database,
        provider,
        historyPageBudget: 1,
        now: () => now.value,
      });
      coordinator.startHistory("vllm", { targetDate: "2026-07-01" });
      await coordinator.waitForIdle();

      expect(pullInputs).toHaveLength(1);
      expect(issueInputs).toHaveLength(1);
      expect(getRepositoryHistoryState(database, "vllm", "pull_request")).toMatchObject({
        status: "idle",
        resumeAfter: resetAt,
      });

      now.value = new Date(resetAt);
      vi.advanceTimersByTime(1_000);
      await vi.runAllTimersAsync();
      await coordinator.waitForIdle();
      expect(pullInputs).toHaveLength(2);
      expect(issueInputs).toHaveLength(2);
      expect(getRepositoryHistoryState(database, "vllm", "pull_request").resumeAfter).toBeNull();
      await coordinator.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("waits for a persisted future history reset after restart", async () => {
    vi.useFakeTimers();
    try {
      const database = fixture();
      const interrupted = createSyncRun(database, {
        repositoryId: "vllm",
        kind: "history",
        entityKinds: ["pull_request", "issue"],
      });
      markSyncRunStarted(database, interrupted.syncRunId, "2026-09-10T09:00:00.000Z");
      const resetAt = "2026-09-10T10:00:01.000Z";
      for (const entityKind of ["pull_request", "issue"] as const) {
        completeSyncRunStream(database, interrupted.syncRunId, entityKind, {
          finishedAt: "2026-09-10T09:01:00.000Z",
          status: "partial",
        });
        updateRepositoryHistoryState(database, "vllm", entityKind, {
          enabled: true,
          status: "idle",
          targetDate: "2026-07-01",
          cursor: `${entityKind}-reset-cursor`,
          recoveryAnchorUpdatedAt: "2026-08-01T00:00:00.000Z",
          lastRunId: interrupted.syncRunId,
          resumeAfter: resetAt,
        });
      }
      const now = { value: new Date("2026-09-10T10:00:00.000Z") };
      const pullInputs: HistorySyncInput[] = [];
      const issueInputs: HistorySyncInput[] = [];
      const base = providerFor({ pull: undefined, issue: undefined });
      const provider: GitHubMetadataProvider = {
        ...base,
        async *fetchPullRequestHistory(input) {
          pullInputs.push(input);
          yield {
            items: [],
            pageInfo: { hasNextPage: false, endCursor: null },
            rateLimit: { cost: 1, remaining: 4999, resetAt },
          };
        },
        async *fetchIssueHistory(input) {
          issueInputs.push(input);
          yield {
            items: [],
            pageInfo: { hasNextPage: false, endCursor: null },
            rateLimit: { cost: 1, remaining: 4999, resetAt },
          };
        },
      };
      const coordinator = new RepositorySyncCoordinator({
        database,
        provider,
        now: () => now.value,
      });

      coordinator.resumeEnabledHistories();
      await coordinator.waitForIdle();
      expect(pullInputs).toHaveLength(0);
      expect(issueInputs).toHaveLength(0);

      now.value = new Date(resetAt);
      vi.advanceTimersByTime(1_000);
      await vi.runAllTimersAsync();
      await coordinator.waitForIdle();
      expect(pullInputs[0]?.cursor).toBe("pull_request-reset-cursor");
      expect(issueInputs[0]?.cursor).toBe("issue-reset-cursor");
      await coordinator.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not block another repository while one repository is foreground-active", async () => {
    const database = fixture(["vllm", "other"]);
    const base = providerFor({ pull: undefined, issue: undefined });
    const started = deferred<void>();
    const release = deferred<void>();
    const otherDone = deferred<void>();
    const repositories: string[] = [];
    const provider: GitHubMetadataProvider = {
      ...base,
      async fetchPullRequest(input) {
        repositories.push(input.repository.name);
        if (input.repository.name === "vllm") {
          started.resolve(undefined);
          await release.promise;
        } else {
          otherDone.resolve(undefined);
        }
        return pullRequestItem({ number: input.number });
      },
    };
    const coordinator = new RepositorySyncCoordinator({
      database,
      provider,
      maxConcurrentRepositories: 2,
    });

    coordinator.startFetchPullRequest("vllm", 1);
    await started.promise;
    coordinator.startFetchPullRequest("other", 2);
    await otherDone.promise;
    expect(repositories).toEqual(["vllm", "other"]);
    release.resolve(undefined);
    await coordinator.waitForIdle();
    await coordinator.close();
  });

  it("cancels a delayed history continuation on close", async () => {
    const database = fixture();
    const base = providerFor({ pull: undefined, issue: undefined });
    let pullHistoryCalls = 0;
    let issueHistoryCalls = 0;
    const provider: GitHubMetadataProvider = {
      ...base,
      async *fetchPullRequestHistory() {
        pullHistoryCalls += 1;
        yield {
          items: [pullRequestItem({ number: 51, updatedAt: "2026-09-01T00:00:00.000Z" })],
          pageInfo: { hasNextPage: true, endCursor: "next" },
          rateLimit: { cost: 1, remaining: 4999, resetAt: "2026-09-10T00:00:00.000Z" },
        };
      },
      async *fetchIssueHistory() {
        issueHistoryCalls += 1;
        yield {
          items: [issueItem({ number: 51, updatedAt: "2026-09-01T00:00:00.000Z" })],
          pageInfo: { hasNextPage: true, endCursor: "next" },
          rateLimit: { cost: 1, remaining: 4999, resetAt: "2026-09-10T00:00:00.000Z" },
        };
      },
    };
    const coordinator = new RepositorySyncCoordinator({
      database,
      provider,
      historyPageBudget: 1,
    });
    const run = coordinator.startHistory("vllm", { targetDate: "2026-07-01" });
    await coordinator.waitForRun(run.syncRunId);
    await coordinator.close();
    expect(pullHistoryCalls).toBe(1);
    expect(issueHistoryCalls).toBe(1);
    expect(() => coordinator.start("vllm")).toThrowError(/after coordinator close/);
  });
});

function pullRequestItem(overrides: Partial<PullRequestMetadata> = {}): PullRequestMetadata {
  return {
    nodeId: `PR_NODE_${overrides.number ?? 1}`,
    number: 1,
    title: "History PR",
    url: "https://github.com/openai/vllm/pull/1",
    stateRaw: "OPEN",
    status: "open",
    isDraft: false,
    authorLogin: "octocat",
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
    closedAt: null,
    mergedAt: null,
    baseRefName: "main",
    headRefName: "feature/history",
    headSha: "0123456789abcdef0123456789abcdef01234567",
    additions: 1,
    deletions: 1,
    changedFilesCount: 1,
    ...overrides,
  };
}

function issueItem(overrides: Partial<IssueMetadata> = {}): IssueMetadata {
  return {
    nodeId: `ISSUE_NODE_${overrides.number ?? 1}`,
    number: 1,
    title: "History issue",
    url: "https://github.com/openai/vllm/issues/1",
    state: "OPEN",
    status: "open",
    authorLogin: "octocat",
    commentsCount: 0,
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
    closedAt: null,
    ...overrides,
  };
}
