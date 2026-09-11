import {
  openDatabase,
  reconcileRepositories,
  upsertPullRequestPage,
  type DatabaseClient,
  type PullRequestMetadata,
} from "@loongboard/database";
import { afterEach, describe, expect, it } from "vitest";

import { buildTestApp } from "../src/app.js";
import { createSyncCoordinatorStub } from "./support/sync-coordinator.js";

const apps: Array<ReturnType<typeof buildTestApp>> = [];
const databases: DatabaseClient[] = [];

const coordinator = createSyncCoordinatorStub({
  configureHistory: () => undefined,
});

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  for (const database of databases.splice(0)) {
    if (database.open) database.close();
  }
});

function setup(): ReturnType<typeof buildTestApp> {
  const database = openDatabase(":memory:");
  databases.push(database);
  reconcileRepositories(database, [
    {
      key: "vllm",
      name: "vLLM",
      github: "openai/vllm",
      path: "/workspace/vllm",
      remote: "origin",
      defaultBranch: "main",
      worktreeSlots: 1,
    },
  ]);
  const app = buildTestApp(
    {
      database,
      timezone: "UTC",
      syncCoordinator: coordinator,
    },
    { logger: false },
  );
  apps.push(app);
  return app;
}

describe("sync history settings route", () => {
  it("labels both GET and PUT settings rows by entity kind", async () => {
    const app = setup();

    const getResponse = await app.inject({
      method: "GET",
      url: "/api/repositories/vllm/sync-history",
    });
    expect(getResponse.statusCode).toBe(200);
    expect(getResponse.json().settings.map((item: { entityKind: string }) => item.entityKind)).toEqual([
      "pull_request",
      "issue",
    ]);

    const putResponse = await app.inject({
      method: "PUT",
      url: "/api/repositories/vllm/sync-history",
      payload: { targetDate: null },
    });
    expect(putResponse.statusCode).toBe(200);
    expect(putResponse.json().settings.map((item: { entityKind: string }) => item.entityKind)).toEqual([
      "pull_request",
      "issue",
    ]);
  });

  it("serves the merged projection with page pagination and filtered totals", async () => {
    const app = setup();
    const database = databases[0]!;
    upsertPullRequestPage(database, "vllm", [
      testPullRequest(3, "2026-09-03T00:00:00.000Z", "2026-09-03T00:00:00.000Z"),
      testPullRequest(2, "2026-09-10T00:00:00.000Z", "2026-09-02T00:00:00.000Z"),
      testPullRequest(1, "2026-09-01T00:00:00.000Z", null),
    ]);

    const first = await app.inject({
      method: "GET",
      url: "/api/repositories/vllm/merged?page=1&limit=1",
    });
    expect(first.statusCode).toBe(200);
    expect(first.json().items.map((item: { number: number }) => item.number)).toEqual([3]);
    expect(first.json()).toMatchObject({ page: 1, pageSize: 1, totalCount: 2, totalPages: 2 });

    const second = await app.inject({
      method: "GET",
      url: "/api/repositories/vllm/merged?page=2&limit=1",
    });
    expect(second.statusCode).toBe(200);
    expect(second.json().items.map((item: { number: number }) => item.number)).toEqual([2]);
    expect(second.json()).toMatchObject({ page: 2, pageSize: 1, totalCount: 2, totalPages: 2 });
  });

  it("passes PR page, sort, and filters through the route response", async () => {
    const app = setup();
    const database = databases[0]!;
    upsertPullRequestPage(database, "vllm", [
      testPullRequest(3, "2026-09-03T00:00:00.000Z", "2026-09-03T00:00:00.000Z"),
      testPullRequest(2, "2026-09-02T00:00:00.000Z", "2026-09-02T00:00:00.000Z"),
      testPullRequest(1, "2026-09-01T00:00:00.000Z", null),
    ]);

    const response = await app.inject({
      method: "GET",
      url: "/api/repositories/vllm/pulls?page=2&limit=1&sort=number&status=merged&search=pull",
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().items.map((item: { number: number }) => item.number)).toEqual([2]);
    expect(response.json()).toMatchObject({ page: 2, pageSize: 1, totalCount: 2, totalPages: 2 });

    const invalid = await app.inject({
      method: "GET",
      url: "/api/repositories/vllm/pulls?page=0",
    });
    expect(invalid.statusCode).toBe(400);

    const unsafe = await app.inject({
      method: "GET",
      url: "/api/repositories/vllm/pulls?page=9007199254740992",
    });
    expect(unsafe.statusCode).toBe(400);
  });
});

function testPullRequest(
  number: number,
  updatedAt: string,
  mergedAt: string | null,
): PullRequestMetadata {
  return {
    nodeId: `pr-node-${number}`,
    number,
    title: `Pull request ${number}`,
    url: `https://github.com/openai/vllm/pull/${number}`,
    authorLogin: "octocat",
    stateRaw: mergedAt === null ? "OPEN" : "MERGED",
    status: mergedAt === null ? "open" : "merged",
    isDraft: false,
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt,
    closedAt: mergedAt,
    mergedAt,
    baseRefName: "main",
    headRefName: `feature/${number}`,
    headSha: `${String(number).padStart(2, "0")}${"a".repeat(38)}`,
    additions: 1,
    deletions: 1,
    changedFilesCount: 1,
  };
}
