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
import { afterEach, describe, expect, it } from "vitest";

const fixtures: Array<{ database: DatabaseClient; root: string }> = [];

afterEach(() => {
  for (const fixture of fixtures.splice(0)) {
    if (fixture.database.open) fixture.database.close();
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

function fixture(): DatabaseClient {
  const root = mkdtempSync(join(tmpdir(), "loongboard-sync-coordinator-"));
  const database = openDatabase(join(root, "state.sqlite3"));
  fixtures.push({ database, root });
  reconcileRepositories(database, [
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
  return database;
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
