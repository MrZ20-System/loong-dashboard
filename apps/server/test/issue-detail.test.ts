import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  getIssueDetailSyncedUpdatedAt,
  openDatabase,
  reconcileRepositories,
  replaceIssueDetailCache,
  upsertIssuePage,
  type ConfiguredRepository,
  type DatabaseClient,
  type IssueDetailCacheInput,
  type IssueMetadata,
} from "@loongboard/database";
import type {
  FetchedIssueDetail,
  GitHubMetadataProvider,
  IssueDetailInput,
  IssuePage,
  IssueSyncInput,
  PullRequestFilesInput,
  PullRequestFilesResult,
  PullRequestPage,
  PullRequestSyncInput,
} from "@loongboard/github";
import { afterEach, describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";
import type { SyncCoordinator } from "../src/sync-coordinator.js";

const temporaryDirectories: string[] = [];
const databases: DatabaseClient[] = [];
const apps: Array<ReturnType<typeof buildApp>> = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  for (const database of databases.splice(0)) {
    if (database.open) database.close();
  }
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function database(): DatabaseClient {
  const directory = mkdtempSync(join(tmpdir(), "loongboard-issue-detail-"));
  temporaryDirectories.push(directory);
  const client = openDatabase(join(directory, "loongboard.sqlite3"));
  databases.push(client);
  return client;
}

function repository(): ConfiguredRepository {
  return {
    key: "alpha",
    name: "ALPHA",
    github: "acme/alpha",
    path: "/workspace/alpha",
    remote: "origin",
    defaultBranch: "main",
    worktreeSlots: 1,
  };
}

function setup(): { client: DatabaseClient; app: ReturnType<typeof buildApp>; provider: IssueDetailProvider } {
  const client = database();
  reconcileRepositories(client, [repository()]);
  const provider = new IssueDetailProvider();
  const app = buildApp({
    database: client,
    timezone: "Asia/Shanghai",
    syncCoordinator: fakeCoordinator(),
    github: provider,
  });
  apps.push(app);
  return { client, app, provider };
}

function issue(number: number, updatedAt: string): IssueMetadata {
  return {
    nodeId: `issue-node-${number}`,
    number,
    title: `Issue ${number}`,
    url: `https://github.com/acme/alpha/issues/${number}`,
    authorLogin: "list-author",
    status: "open",
    commentsCount: 0,
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt,
    closedAt: null,
  };
}

function fetched(updatedAt: string): FetchedIssueDetail {
  return {
    number: 7,
    title: "Fetched issue",
    url: "https://github.com/acme/alpha/issues/7",
    state: "open",
    authorLogin: "author",
    commentsCount: 2,
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt,
    closedAt: null,
    body: "# Fetched body\n\nBody paragraph.",
    comments: [
      {
        id: 2,
        authorLogin: "bob",
        body: "Second fetched comment",
        createdAt: "2026-09-03T00:02:00.000Z",
        updatedAt: "2026-09-03T00:02:00.000Z",
        url: "https://github.com/acme/alpha/issues/7#issuecomment-2",
      },
      {
        id: 1,
        authorLogin: "alice",
        body: "First fetched comment",
        createdAt: "2026-09-03T00:01:00.000Z",
        updatedAt: "2026-09-03T00:01:00.000Z",
        url: "https://github.com/acme/alpha/issues/7#issuecomment-1",
      },
    ],
  };
}

function cacheInput(updatedAt: string): IssueDetailCacheInput {
  return {
    number: 7,
    title: "Issue 7",
    url: "https://github.com/acme/alpha/issues/7",
    state: "open",
    authorLogin: "list-author",
    commentsCount: 1,
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt,
    closedAt: null,
    body: "Cached body paragraph.",
    comments: [
      {
        id: 1,
        authorLogin: "alice",
        body: "Cached comment",
        createdAt: "2026-09-03T00:01:00.000Z",
        updatedAt: "2026-09-03T00:01:00.000Z",
        url: "https://github.com/acme/alpha/issues/7#issuecomment-1",
      },
    ],
  };
}

class IssueDetailProvider implements GitHubMetadataProvider {
  readonly calls: IssueDetailInput[] = [];
  result: FetchedIssueDetail | null = null;
  failure: Error | null = null;

  fetchIssueUpdates(_input: IssueSyncInput): AsyncIterable<IssuePage> {
    return emptyIssuePages();
  }

  fetchPullRequestUpdates(_input: PullRequestSyncInput): AsyncIterable<PullRequestPage> {
    return emptyPullRequestPages();
  }

  async fetchPullRequestFiles(
    input: PullRequestFilesInput,
  ): Promise<PullRequestFilesResult[]> {
    void input;
    return [];
  }

  async fetchIssueDetail(input: IssueDetailInput): Promise<FetchedIssueDetail> {
    this.calls.push(input);
    if (this.failure !== null) throw this.failure;
    if (this.result === null) throw new Error("test provider has no detail result");
    return this.result;
  }
}

function fakeCoordinator(): SyncCoordinator {
  return {
    start: (repositoryId) => ({
      repositoryId,
      syncRunId: "test-run",
      startedAt: "2026-09-03T00:00:00.000Z",
    }),
    waitForIdle: async () => undefined,
    close: async () => undefined,
  };
}

async function* emptyIssuePages(): AsyncGenerator<IssuePage> {}

async function* emptyPullRequestPages(): AsyncGenerator<PullRequestPage> {}

describe("Issue detail lazy cache route", () => {
  it("keeps the Issue list summary free of cached body and comments", async () => {
    const { client, app } = setup();
    upsertIssuePage(client, "alpha", [issue(7, "2026-09-03T00:00:00.000Z")]);
    replaceIssueDetailCache(
      client,
      "alpha",
      cacheInput("2026-09-03T00:00:00.000Z"),
    );

    const response = await app.inject({
      method: "GET",
      url: "/api/repositories/alpha/issues",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      items: [
        {
          repositoryId: "alpha",
          number: 7,
          title: "Issue 7",
          url: "https://github.com/acme/alpha/issues/7",
          authorLogin: "list-author",
          status: "open",
          commentsCount: 1,
          updatedAt: "2026-09-03T00:00:00.000Z",
        },
      ],
      nextCursor: null,
      calendarTimeZone: "Asia/Shanghai",
    });
    expect(response.body).not.toContain("Cached body paragraph");
    expect(response.body).not.toContain("Cached comment");
  });

  it("fetches on cache miss, persists the cache, and returns it on later hits", async () => {
    const { client, app, provider } = setup();
    upsertIssuePage(client, "alpha", [issue(7, "2026-09-03T00:00:00.000Z")]);
    provider.result = fetched("2026-09-03T00:00:00.000Z");

    const first = await app.inject({
      method: "GET",
      url: "/api/repositories/alpha/issues/7",
    });

    expect(first.statusCode).toBe(200);
    expect(provider.calls).toEqual([
      {
        repository: { owner: "acme", name: "alpha" },
        number: 7,
      },
    ]);
    expect(first.json()).toMatchObject({
      title: "Fetched issue",
      detailBody: "# Fetched body\n\nBody paragraph.",
      commentsCount: 2,
      comments: [
        { id: 1, authorLogin: "alice", body: "First fetched comment" },
        { id: 2, authorLogin: "bob", body: "Second fetched comment" },
      ],
    });
    expect(
      getIssueDetailSyncedUpdatedAt(client, "alpha", 7),
    ).toBe("2026-09-03T00:00:00.000Z");

    const second = await app.inject({
      method: "GET",
      url: "/api/repositories/alpha/issues/7",
    });
    expect(second.statusCode).toBe(200);
    expect(provider.calls).toHaveLength(1);
  });

  it("refetches when a summary upsert advances updated_at past the cache marker", async () => {
    const { client, app, provider } = setup();
    upsertIssuePage(client, "alpha", [issue(7, "2026-09-03T00:00:00.000Z")]);
    replaceIssueDetailCache(
      client,
      "alpha",
      cacheInput("2026-09-03T00:00:00.000Z"),
    );
    upsertIssuePage(client, "alpha", [issue(7, "2026-09-04T00:00:00.000Z")]);
    provider.result = fetched("2026-09-04T00:00:00.000Z");

    const first = await app.inject({
      method: "GET",
      url: "/api/repositories/alpha/issues/7",
    });
    expect(first.statusCode).toBe(200);
    expect(provider.calls).toHaveLength(1);
    expect(first.json()).toMatchObject({
      updatedAt: "2026-09-04T00:00:00.000Z",
      detailBody: "# Fetched body\n\nBody paragraph.",
      comments: [{ id: 1 }, { id: 2 }],
    });

    const second = await app.inject({
      method: "GET",
      url: "/api/repositories/alpha/issues/7",
    });
    expect(second.statusCode).toBe(200);
    expect(provider.calls).toHaveLength(1);
  });

  it("returns 404 without contacting GitHub for unknown Issues", async () => {
    const { app, provider } = setup();
    const response = await app.inject({
      method: "GET",
      url: "/api/repositories/alpha/issues/404",
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({
      error: { code: "ISSUE_NOT_FOUND" },
    });
    expect(provider.calls).toHaveLength(0);
  });
});
