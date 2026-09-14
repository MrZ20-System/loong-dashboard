import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  openDatabase,
  reconcileRepositories,
  upsertPullRequestPage,
  type ConfiguredRepository,
  type DatabaseClient,
  type PullRequestMetadata,
} from "@loongboard/database";
import type {
  GitWorkspace,
  PreparePullInput,
} from "@loongboard/git-workspace";
import { afterEach, describe, expect, it, vi } from "vitest";

import { buildTestApp } from "../src/app.js";
import { createSyncCoordinatorStub } from "./support/sync-coordinator.js";

const temporaryDirectories: string[] = [];
const databases: DatabaseClient[] = [];
const apps: Array<ReturnType<typeof buildTestApp>> = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  for (const database of databases.splice(0)) {
    if (database.open) database.close();
  }
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function setupDatabase(): DatabaseClient {
  const directory = mkdtempSync(join(tmpdir(), "loongboard-pr-diff-"));
  temporaryDirectories.push(directory);
  const database = openDatabase(join(directory, "loongboard.sqlite3"));
  databases.push(database);
  const repository: ConfiguredRepository = {
    key: "alpha",
    name: "Alpha",
    github: "acme/alpha",
    path: "/workspace/alpha",
    remote: "origin",
    defaultBranch: "main",
    worktreeSlots: 1,
  };
  reconcileRepositories(database, [repository]);
  const pullRequest: PullRequestMetadata = {
    nodeId: "pr_7",
    number: 7,
    title: "Release branch fix",
    url: "https://github.com/acme/alpha/pull/7",
    stateRaw: "OPEN",
    status: "open",
    isDraft: false,
    createdAt: "2026-09-15T00:00:00.000Z",
    updatedAt: "2026-09-15T00:00:00.000Z",
    closedAt: null,
    mergedAt: null,
    baseRefName: "release/0.1",
    headRefName: "fix/release-only",
    headSha: "b".repeat(40),
    additions: 1,
    deletions: 0,
    changedFilesCount: 1,
  };
  upsertPullRequestPage(database, "alpha", [pullRequest]);
  return database;
}

describe("PR diff preparation", () => {
  it("computes the comparison from the PR base branch instead of the repository default", async () => {
    const database = setupDatabase();
    const preparePull = vi.fn(async (input: PreparePullInput) => ({
      headSha: input.headSha,
      mergeBase: "a".repeat(40),
      fetched: false,
    }));
    const gitWorkspace: GitWorkspace = {
      preparePull,
      listChangedFiles: vi.fn(async () => []),
      listFilesAtRef: vi.fn(async () => []),
      readFile: vi.fn(async ({ path, ref }) => ({
        path,
        ref,
        binary: false,
        sizeBytes: 0,
        content: "",
        tooLarge: false,
      })),
    };
    const app = buildTestApp({
      database,
      timezone: "Asia/Shanghai",
      syncCoordinator: createSyncCoordinatorStub(),
      gitWorkspace,
    });
    apps.push(app);

    const response = await app.inject({
      method: "POST",
      url: "/api/repositories/alpha/pulls/7/prepare",
    });

    expect(response.statusCode).toBe(200);
    expect(preparePull).toHaveBeenCalledOnce();
    expect(preparePull).toHaveBeenCalledWith(expect.objectContaining({
      baseBranch: "release/0.1",
      prNumber: 7,
      headSha: "b".repeat(40),
    }));
  });
});
