import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  getRepositorySyncStatus,
  listRepositories,
  openDatabase,
  reconcileRepositories,
  SyncAlreadyRunningError,
  upsertIssuePage,
  upsertPullRequestPage,
  type ConfiguredRepository,
  type DatabaseClient,
} from "@loongboard/database";
import * as databaseModule from "@loongboard/database";
import {
  type GitHubMetadataProvider,
  type IssueMetadata,
  type IssuePage,
  type IssueSyncInput,
  type PullRequestMetadata,
  type PullRequestPage,
  type PullRequestSyncInput,
} from "@loongboard/github";
import { afterEach, describe, expect, it, vi } from "vitest";

import { buildApp } from "../src/app.js";
import {
  createServerRuntime,
  runtimeDatabasePath,
} from "../src/runtime.js";
import type { SystemConfig } from "../src/config.js";
import {
  RepositorySyncCoordinator,
  type SyncCoordinator,
} from "../src/sync-coordinator.js";

const temporaryDirectories: string[] = [];
const databases: DatabaseClient[] = [];
const apps: Array<ReturnType<typeof buildApp>> = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(apps.splice(0).map((app) => app.close()));
  for (const database of databases.splice(0)) {
    if (database.open) database.close();
  }
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function database(): DatabaseClient {
  const directory = mkdtempSync(join(tmpdir(), "loongboard-server-stage1-"));
  temporaryDirectories.push(directory);
  const client = openDatabase(join(directory, "loongboard.sqlite3"));
  databases.push(client);
  return client;
}

function repository(key: string): ConfiguredRepository {
  return {
    key,
    name: key.toUpperCase(),
    github: `acme/${key}`,
    path: `/workspace/${key}`,
    remote: "origin",
    defaultBranch: "main",
    worktreeSlots: 2,
  };
}

function setupDatabase(...keys: string[]): DatabaseClient {
  const client = database();
  reconcileRepositories(
    client,
    keys.map((key) => repository(key)),
    "2026-09-03T00:00:00.000Z",
  );
  return client;
}

function runtimeConfig(root: string): SystemConfig {
  return {
    version: 1,
    timezone: "Asia/Shanghai",
    repositories: [repository("alpha")],
    knowledge: {
      path: join(root, "knowledge"),
      inbox: join(root, "knowledge", "inbox"),
      historyLimit: 10,
    },
    runtime: {
      statePath: join(root, ".loong"),
      worktreesPath: join(root, ".worktrees"),
      serverHost: "127.0.0.1",
      serverPort: 4174,
    },
    agent: {
      defaultProvider: "deepseek-official",
      defaultModel: "deepseek-v4-flash",
      defaultReasoningEffort: "high",
      idleProcessMinutes: 20,
    },
  };
}

function pullRequest(number: number, updatedAt: string): PullRequestMetadata {
  return {
    nodeId: `pr-${number}`,
    number,
    title: `Pull request ${number}`,
    url: `https://github.com/acme/repo/pull/${number}`,
    authorLogin: "author",
    stateRaw: "OPEN",
    status: "open",
    isDraft: false,
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt,
    closedAt: null,
    mergedAt: null,
    baseRefName: "main",
    headRefName: "feature",
    headSha: `${number}`.padStart(40, "0"),
    additions: 2,
    deletions: 1,
    changedFilesCount: 1,
  };
}

function issue(number: number, updatedAt: string): IssueMetadata {
  return {
    nodeId: `issue-${number}`,
    number,
    title: `Issue ${number}`,
    url: `https://github.com/acme/repo/issues/${number}`,
    state: "OPEN",
    authorLogin: null,
    status: "open",
    commentsCount: 0,
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt,
    closedAt: null,
  };
}

function pullPage(items: readonly PullRequestMetadata[]): PullRequestPage {
  return {
    items,
    pageInfo: { hasNextPage: false, endCursor: null },
    rateLimit: {
      cost: 1,
      remaining: 99,
      resetAt: "2026-09-03T02:00:00.000Z",
    },
  };
}

function issuePage(items: readonly IssueMetadata[]): IssuePage {
  return {
    items,
    pageInfo: { hasNextPage: false, endCursor: null },
    rateLimit: {
      cost: 1,
      remaining: 98,
      resetAt: "2026-09-03T02:00:00.000Z",
    },
  };
}

class RecordingProvider implements GitHubMetadataProvider {
  readonly pullInputs: PullRequestSyncInput[] = [];
  readonly issueInputs: IssueSyncInput[] = [];
  pullFactory: (input: PullRequestSyncInput) => AsyncIterable<PullRequestPage> =
    async function* () {
      yield pullPage([]);
    };
  issueFactory: (input: IssueSyncInput) => AsyncIterable<IssuePage> =
    async function* () {
      yield issuePage([]);
    };

  fetchPullRequestUpdates(
    input: PullRequestSyncInput,
  ): AsyncIterable<PullRequestPage> {
    this.pullInputs.push(input);
    return this.pullFactory(input);
  }

  fetchIssueUpdates(input: IssueSyncInput): AsyncIterable<IssuePage> {
    this.issueInputs.push(input);
    return this.issueFactory(input);
  }
}

function fakeCoordinator(
  start: SyncCoordinator["start"] = (repositoryId) => ({
    repositoryId,
    syncRunId: "test-run",
    startedAt: "2026-09-03T00:00:00.000Z",
  }),
): SyncCoordinator {
  return {
    start,
    waitForIdle: async () => undefined,
    close: async () => undefined,
  };
}

function appFor(client: DatabaseClient, coordinator = fakeCoordinator()) {
  const app = buildApp({
    database: client,
    timezone: "Asia/Shanghai",
    syncCoordinator: coordinator,
  });
  apps.push(app);
  return app;
}

describe("Stage 1 HTTP routes", () => {
  it("serves repositories, lists, activity days, and sync status from SQLite", async () => {
    const client = setupDatabase("alpha");
    upsertPullRequestPage(client, "alpha", [
      pullRequest(1, "2026-09-03T00:00:00.000Z"),
    ]);
    upsertIssuePage(client, "alpha", [
      issue(2, "2026-09-03T00:00:00.000Z"),
    ]);

    const app = appFor(client);
    const repositories = await app.inject({ method: "GET", url: "/api/repositories" });
    expect(repositories.statusCode).toBe(200);
    expect(repositories.json()).toEqual({
      items: [
        expect.objectContaining({ id: "alpha", key: "alpha", githubOwner: "acme" }),
      ],
    });

    const pulls = await app.inject({
      method: "GET",
      url: "/api/repositories/alpha/pulls?date=2026-09-03&status=open",
    });
    expect(pulls.statusCode).toBe(200);
    expect(pulls.json()).toMatchObject({
      calendarTimeZone: "Asia/Shanghai",
      items: [{ number: 1, status: "open", changedFilesCount: 1 }],
      nextCursor: null,
    });

    const issues = await app.inject({
      method: "GET",
      url: "/api/repositories/alpha/issues?date=2026-09-03",
    });
    expect(issues.statusCode).toBe(200);
    expect(issues.json()).toMatchObject({
      calendarTimeZone: "Asia/Shanghai",
      items: [{ number: 2, status: "open", commentsCount: 0 }],
    });

    const activity = await app.inject({
      method: "GET",
      url: "/api/repositories/alpha/pulls/activity-days?from=2026-09-01&to=2026-09-03",
    });
    expect(activity.statusCode).toBe(200);
    expect(activity.json()).toEqual({
      days: [{ date: "2026-09-03", count: 1 }],
      calendarTimeZone: "Asia/Shanghai",
    });

    const status = await app.inject({
      method: "GET",
      url: "/api/repositories/alpha/sync-status",
    });
    expect(status.statusCode).toBe(200);
    expect(status.json()).toMatchObject({
      repositoryId: "alpha",
      status: "idle",
      pullRequests: { entityKind: "pull_request", status: "idle" },
      issues: { entityKind: "issue", status: "idle" },
    });
  });

  it("uses strict request parsing and consistent 400/404/409 envelopes", async () => {
    const client = setupDatabase("alpha");
    const app = appFor(client, fakeCoordinator(() => {
      throw new SyncAlreadyRunningError("alpha");
    }));

    const invalidQuery = await app.inject({
      method: "GET",
      url: "/api/repositories/alpha/pulls?status=unknown",
    });
    expect(invalidQuery.statusCode).toBe(400);
    expect(invalidQuery.json()).toMatchObject({ error: { code: "INVALID_REQUEST" } });

    const invalidCursor = await app.inject({
      method: "GET",
      url: "/api/repositories/alpha/pulls?cursor=not-a-valid-cursor",
    });
    expect(invalidCursor.statusCode).toBe(400);
    expect(invalidCursor.json()).toMatchObject({ error: { code: "INVALID_CURSOR" } });

    const missing = await app.inject({
      method: "GET",
      url: "/api/repositories/missing/issues",
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toMatchObject({ error: { code: "REPOSITORY_NOT_FOUND" } });

    const accepted = await app.inject({
      method: "POST",
      url: "/api/repositories/alpha/sync",
    });
    expect(accepted.statusCode).toBe(409);
    expect(accepted.json()).toMatchObject({ error: { code: "SYNC_ALREADY_RUNNING" } });

    const unknownQuery = await app.inject({
      method: "GET",
      url: "/api/repositories/alpha/issues?limit=2",
    });
    expect(unknownQuery.statusCode).toBe(400);
  });

  it("returns the frozen 202 response for a manual sync", async () => {
    const client = setupDatabase("alpha");
    const app = appFor(client);
    const response = await app.inject({
      method: "POST",
      url: "/api/repositories/alpha/sync",
    });
    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual({
      repositoryId: "alpha",
      syncRunId: "test-run",
      status: "accepted",
    });
  });

  it("rejects a request body and malformed JSON with the shared 400 envelope", async () => {
    const client = setupDatabase("alpha");
    const app = appFor(client);

    const body = await app.inject({
      method: "POST",
      url: "/api/repositories/alpha/sync",
      headers: { "content-type": "application/json" },
      payload: { unexpected: true },
    });
    expect(body.statusCode).toBe(400);
    expect(body.json()).toEqual({
      error: { code: "INVALID_REQUEST", message: "Request body must be empty" },
    });

    const malformed = await app.inject({
      method: "POST",
      url: "/api/repositories/alpha/sync",
      headers: { "content-type": "application/json" },
      payload: '{"unexpected":',
    });
    expect(malformed.statusCode).toBe(400);
    expect(malformed.json()).toMatchObject({
      error: { code: "INVALID_REQUEST", message: "Malformed JSON request body" },
    });

    const raw = await app.inject({
      method: "POST",
      url: "/api/repositories/alpha/sync",
      headers: { "content-type": "text/plain" },
      payload: "unexpected",
    });
    expect(raw.statusCode).toBe(400);
    expect(raw.json()).toMatchObject({ error: { code: "INVALID_REQUEST" } });
  });

  it("maps response schema failures to a generic 500 error", async () => {
    const client = setupDatabase("alpha");
    const validStatus = getRepositorySyncStatus(client, "alpha");
    const statusWithBadTimestamp = {
      ...validStatus,
      pullRequests: {
        ...validStatus.pullRequests,
        lastAttemptAt: "not-a-timestamp",
      },
    };
    const getStatus = vi
      .spyOn(databaseModule, "getRepositorySyncStatus")
      .mockReturnValue(statusWithBadTimestamp);
    const app = appFor(client);

    const response = await app.inject({
      method: "GET",
      url: "/api/repositories/alpha/sync-status",
    });
    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({
      error: { code: "INTERNAL_ERROR", message: "Internal server error" },
    });
    expect(response.body).not.toContain("lastAttemptAt");
    expect(response.body).not.toContain("Invalid datetime");
  });
});

describe("Stage 1 runtime composition", () => {
  it("creates the state directory/database, reconciles config, and closes DB on app close", async () => {
    const root = mkdtempSync(join(tmpdir(), "loongboard-runtime-stage1-"));
    temporaryDirectories.push(root);
    const config = runtimeConfig(root);
    const runtime = createServerRuntime({
      config,
      provider: new RecordingProvider(),
    });
    apps.push(runtime.app);
    databases.push(runtime.database);

    expect(existsSync(config.runtime.statePath)).toBe(true);
    expect(runtime.databasePath).toBe(runtimeDatabasePath(config));
    expect(existsSync(runtime.databasePath)).toBe(true);
    expect(listRepositories(runtime.database)).toEqual([
      expect.objectContaining({ id: "alpha", key: "alpha", enabled: true }),
    ]);
    const response = await runtime.app.inject({
      method: "GET",
      url: "/api/repositories",
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ items: [{ id: "alpha" }] });

    await runtime.app.close();
    expect(runtime.database.open).toBe(false);
  });

  it("waits for gated sync work before closing the runtime database", async () => {
    const root = mkdtempSync(join(tmpdir(), "loongboard-runtime-gated-"));
    temporaryDirectories.push(root);
    const config = runtimeConfig(root);
    const provider = new RecordingProvider();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    provider.pullFactory = async function* () {
      await gate;
      yield pullPage([]);
    };
    provider.issueFactory = async function* () {
      await gate;
      yield issuePage([]);
    };
    const runtime = createServerRuntime({ config, provider });
    apps.push(runtime.app);
    databases.push(runtime.database);

    const response = await runtime.app.inject({
      method: "POST",
      url: "/api/repositories/alpha/sync",
    });
    expect(response.statusCode).toBe(202);

    let closed = false;
    const closePromise = runtime.app.close().then(() => {
      closed = true;
    });
    await Promise.resolve();
    expect(closed).toBe(false);
    expect(runtime.database.open).toBe(true);

    release();
    await closePromise;
    expect(closed).toBe(true);
    expect(runtime.database.open).toBe(false);
  });
});

describe("RepositorySyncCoordinator", () => {
  it("returns 202 without waiting for a gated provider and drains it on close", async () => {
    const client = setupDatabase("alpha");
    const provider = new RecordingProvider();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    provider.pullFactory = async function* () {
      await gate;
      yield pullPage([]);
    };
    provider.issueFactory = async function* () {
      await gate;
      yield issuePage([]);
    };
    const coordinator = new RepositorySyncCoordinator({
      database: client,
      provider,
      now: () => new Date("2026-09-03T01:00:00.000Z"),
    });
    const app = appFor(client, coordinator);
    app.addHook("onClose", async () => {
      await coordinator.close();
      client.close();
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/repositories/alpha/sync",
    });
    expect(response.statusCode).toBe(202);
    expect(provider.pullInputs).toHaveLength(1);
    expect(provider.issueInputs).toHaveLength(1);

    let closed = false;
    const closePromise = app.close().then(() => {
      closed = true;
    });
    await Promise.resolve();
    expect(closed).toBe(false);
    expect(client.open).toBe(true);

    release();
    await closePromise;
    expect(closed).toBe(true);
    expect(client.open).toBe(false);
  });

  it("uses bootstrap then incremental inputs and persists both streams", async () => {
    const client = setupDatabase("alpha");
    const provider = new RecordingProvider();
    provider.pullFactory = async function* () {
      yield pullPage([pullRequest(1, "2026-09-03T00:00:00.000Z")]);
    };
    provider.issueFactory = async function* () {
      yield issuePage([issue(2, "2026-09-03T00:00:00.000Z")]);
    };
    let clock = 0;
    const coordinator = new RepositorySyncCoordinator({
      database: client,
      provider,
      now: () => new Date(`2026-09-03T0${clock++}:00:00.000Z`),
    });

    const first = coordinator.start("alpha");
    await coordinator.waitForIdle();
    expect(provider.pullInputs[0]).toMatchObject({
      mode: "bootstrap",
      watermarkUpdatedAt: null,
      syncStartedAt: first.startedAt,
    });
    expect(provider.issueInputs[0]).toMatchObject({ mode: "bootstrap", watermarkUpdatedAt: null });
    expect(getRepositorySyncStatus(client, "alpha")).toMatchObject({
      status: "idle",
      pullRequests: { watermarkUpdatedAt: first.startedAt, status: "idle" },
      issues: { watermarkUpdatedAt: first.startedAt, status: "idle" },
    });

    const second = coordinator.start("alpha");
    await coordinator.waitForIdle();
    expect(second.startedAt).not.toBe(first.startedAt);
    expect(provider.pullInputs[1]).toMatchObject({
      mode: "incremental",
      watermarkUpdatedAt: first.startedAt,
    });
    expect(provider.issueInputs[1]).toMatchObject({
      mode: "incremental",
      watermarkUpdatedAt: first.startedAt,
    });
  });

  it("fails one entity independently, preserves old rows, and records the error", async () => {
    const client = setupDatabase("alpha");
    const provider = new RecordingProvider();
    provider.pullFactory = async function* () {
      yield pullPage([pullRequest(1, "2026-09-03T00:00:00.000Z")]);
    };
    provider.issueFactory = async function* () {
      throw new Error("GitHub unavailable");
    };
    const coordinator = new RepositorySyncCoordinator({
      database: client,
      provider,
      now: () => new Date("2026-09-03T01:00:00.000Z"),
    });

    const run = coordinator.start("alpha");
    await coordinator.waitForIdle();
    const status = getRepositorySyncStatus(client, "alpha");
    expect(status.pullRequests).toMatchObject({
      status: "idle",
      watermarkUpdatedAt: run.startedAt,
    });
    expect(status.issues).toMatchObject({
      status: "failed",
      watermarkUpdatedAt: null,
      lastError: "GitHub unavailable",
    });
    const app = appFor(client, coordinator);
    const oldList = await app.inject({ method: "GET", url: "/api/repositories/alpha/pulls" });
    expect(oldList.statusCode).toBe(200);
    expect(oldList.json()).toMatchObject({ items: [{ number: 1 }] });
  });

  it("limits background work to two repositories globally", async () => {
    const client = setupDatabase("one", "two", "three");
    const provider = new RecordingProvider();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    provider.pullFactory = async function* () {
      await gate;
      yield pullPage([]);
    };
    provider.issueFactory = async function* () {
      await gate;
      yield issuePage([]);
    };
    const coordinator = new RepositorySyncCoordinator({
      database: client,
      provider,
      now: () => new Date("2026-09-03T01:00:00.000Z"),
    });

    coordinator.start("one");
    coordinator.start("two");
    coordinator.start("three");
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(coordinator.activeRepositoryCount).toBe(2);
    expect(provider.pullInputs).toHaveLength(2);
    expect(provider.issueInputs).toHaveLength(2);
    release();
    await coordinator.waitForIdle();
    expect(provider.pullInputs).toHaveLength(3);
    expect(provider.issueInputs).toHaveLength(3);
  });
});
