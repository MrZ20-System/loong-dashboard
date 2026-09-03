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
import {
  GitCommandError,
  type GitWorkspace,
} from "@loongboard/git-workspace";
import { afterEach, describe, expect, it, vi } from "vitest";

import { buildApp } from "../src/app.js";
import type { SyncCoordinator } from "../src/sync-coordinator.js";

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
  const directory = mkdtempSync(join(tmpdir(), "loongboard-server-stage3-"));
  temporaryDirectories.push(directory);
  const client = openDatabase(join(directory, "loongboard.sqlite3"));
  databases.push(client);
  return client;
}

function repository(key: string, path: string): ConfiguredRepository {
  return {
    key,
    name: key.toUpperCase(),
    github: `acme/${key}`,
    path,
    remote: "origin",
    defaultBranch: "main",
    worktreeSlots: 2,
  };
}

const headSha = "c".repeat(40);
const otherSha = "d".repeat(40);

function prMetadata(number: number, overrides: Partial<PullRequestMetadata> = {}): PullRequestMetadata {
  return {
    nodeId: `pr_${number}`,
    number,
    title: `PR ${number}`,
    url: `https://github.com/acme/alpha/pull/${number}`,
    authorLogin: "octocat",
    stateRaw: "OPEN",
    status: "open",
    isDraft: false,
    createdAt: "2026-09-03T00:00:00.000Z",
    updatedAt: "2026-09-03T01:00:00.000Z",
    closedAt: null,
    mergedAt: null,
    baseRefName: "main",
    headRefName: "feature",
    headSha,
    additions: 10,
    deletions: 2,
    changedFilesCount: 3,
    detailBody: "Body",
    ...overrides,
  };
}

function setup(options: { git?: GitWorkspace } = {}): { app: ReturnType<typeof buildApp> } {
  const client = database();
  reconcileRepositories(client, [repository("alpha", "/work/alpha")]);
  upsertPullRequestPage(client, "alpha", [prMetadata(1)]);
  const coordinator = {
    start: vi.fn(async () => ({ repositoryId: "alpha", syncRunId: "run", startedAt: "2026-09-03T00:00:00.000Z" })),
    close: vi.fn(async () => undefined),
  } as unknown as SyncCoordinator;
  const app = buildApp({
    database: client,
    timezone: "Asia/Shanghai",
    syncCoordinator: coordinator,
    gitWorkspace: options.git ?? fakeGitWorkspace(),
  }, { logger: false });
  apps.push(app);
  return { app };
}

function fakeGitWorkspace(overrides: Partial<GitWorkspace> = {}): GitWorkspace {
  return {
    preparePull: vi.fn(async () => ({ headSha, mergeBase: otherSha, fetched: true })),
    listChangedFiles: vi.fn(async () => []),
    readFile: vi.fn(async () => ({ path: "a.txt", ref: headSha, binary: false, tooLarge: false, sizeBytes: 4, content: "abcd" })),
    ...overrides,
  } as GitWorkspace;
}

async function getJson(response: { body: string }) {
  return JSON.parse(response.body) as Record<string, unknown>;
}

describe("Stage 3 diff routes", () => {
  it("returns the stored PR detail and 404s unknown PRs with the shared envelope", async () => {
    const { app } = setup();
    const ok = await app.inject({ method: "GET", url: "/api/repositories/alpha/pulls/1" });
    expect(ok.statusCode).toBe(200);
    const body = (await getJson(ok)) as { number: number; headSha: string; domains: unknown[] };
    expect(body.number).toBe(1);
    expect(body.headSha).toBe(headSha);
    expect(body.domains).toEqual([]);

    const missing = await app.inject({ method: "GET", url: "/api/repositories/alpha/pulls/99" });
    expect(missing.statusCode).toBe(404);
    expect((await getJson(missing)).error).toMatchObject({ code: "PULL_REQUEST_NOT_FOUND" });

    const repoMissing = await app.inject({ method: "GET", url: "/api/repositories/nope/pulls/1" });
    expect(repoMissing.statusCode).toBe(404);
    expect((await getJson(repoMissing)).error).toMatchObject({ code: "REPOSITORY_NOT_FOUND" });
  });

  it("prepares the PR diff workspace from the stored head SHA and repository config", async () => {
    const preparePull = vi.fn<GitWorkspace["preparePull"]>(async () => ({ headSha, mergeBase: otherSha, fetched: true }));
    const listChangedFiles = vi.fn<GitWorkspace["listChangedFiles"]>(async () => [{
      path: "src/a.ts", previousPath: null, changeType: "modified", additions: 3, deletions: 1, binary: false,
    }]);
    const { app } = setup({ git: fakeGitWorkspace({ preparePull, listChangedFiles }) });

    const response = await app.inject({ method: "POST", url: "/api/repositories/alpha/pulls/1/prepare" });
    expect(response.statusCode).toBe(200);
    expect(preparePull).toHaveBeenCalledWith({
      repositoryPath: "/work/alpha",
      remote: "origin",
      baseBranch: "main",
      prNumber: 1,
      headSha,
    });
    expect(listChangedFiles).toHaveBeenCalledWith({
      repositoryPath: "/work/alpha",
      mergeBase: otherSha,
      headSha,
    });
    const body = await getJson(response);
    expect(body).toMatchObject({
      repositoryId: "alpha", number: 1, headSha, mergeBase: otherSha, fetched: true,
    });
    expect((body.files as unknown[])).toHaveLength(1);
  });

  it("returns changed file content for the requested ref and path", async () => {
    const readFile = vi.fn(async () => ({ path: "src/a.ts", ref: headSha, binary: false, tooLarge: false, sizeBytes: 9, content: "line one" }));
    const { app } = setup({ git: fakeGitWorkspace({ readFile }) });
    const response = await app.inject({
      method: "GET",
      url: `/api/repositories/alpha/pulls/1/file?path=${encodeURIComponent("src/a.ts")}&ref=${headSha}`,
    });
    expect(response.statusCode).toBe(200);
    expect(readFile).toHaveBeenCalledWith({
      repositoryPath: "/work/alpha", ref: headSha, path: "src/a.ts",
    });
    expect(await getJson(response)).toMatchObject({ path: "src/a.ts", content: "line one" });
  });

  it("rejects unsafe refs and paths and reports missing files as 404", async () => {
    const { app } = setup();
    const badRef = await app.inject({ method: "GET", url: `/api/repositories/alpha/pulls/1/file?path=a.txt&ref=${"0".repeat(41)}` });
    expect(badRef.statusCode).toBe(400);

    const unsafePath = await app.inject({ method: "GET", url: `/api/repositories/alpha/pulls/1/file?path=${encodeURIComponent("../secret")}&ref=${headSha}` });
    expect(unsafePath.statusCode).toBe(400);

    const { app: missingApp } = setup({
      git: fakeGitWorkspace({
        readFile: vi.fn(async () => {
          throw new GitCommandError("/work/alpha", ["show", `${headSha}:gone.txt`], 128, "fatal: path 'gone.txt' does not exist in 'HEAD'");
        }),
      }),
    });
    const missing = await missingApp.inject({ method: "GET", url: `/api/repositories/alpha/pulls/1/file?path=gone.txt&ref=${headSha}` });
    expect(missing.statusCode).toBe(404);
    expect((await getJson(missing)).error).toMatchObject({ code: "FILE_NOT_FOUND" });
  });

  it("exposes the copyable local checkout command", async () => {
    const { app } = setup();
    const response = await app.inject({ method: "GET", url: "/api/repositories/alpha/pulls/1/local-command" });
    expect(response.statusCode).toBe(200);
    const expected = ["git", "fetch", "origin pull/1/head:pr-1", "&&", "git", "switch", "pr-1"].join(" ");
    expect(await getJson(response)).toEqual({ command: expected });
  });
});
