import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildTestApp } from "../../apps/server/src/app.js";
import { KnowledgeController } from "../../apps/server/src/index.js";
import { createSyncCoordinatorStub } from "../../apps/server/test/support/sync-coordinator.js";
import {
  listDocumentVersions,
  openDatabase,
  reconcileRepositories,
  upsertIssuePage,
} from "../../packages/database/src/index.js";
import type {
  FetchedIssueDetail,
  GitHubMetadataProvider,
} from "../../packages/github/src/index.js";
import { afterEach, describe, expect, it, vi } from "vitest";

const cleanups: Array<() => void | Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function createRepository(database: ReturnType<typeof openDatabase>): void {
  reconcileRepositories(database, [{
    key: "repo",
    name: "Repository",
    github: "owner/repo",
    path: "/tmp/repo",
    remote: "origin",
    defaultBranch: "main",
    worktreeSlots: 1,
  }], "2026-01-01T00:00:00.000Z");
}

function provider(detail: FetchedIssueDetail): GitHubMetadataProvider {
  return {
    fetchPullRequestUpdates: async function* () {},
    fetchIssueUpdates: async function* () {},
    fetchPullRequestFiles: async () => [],
    fetchIssueDetail: vi.fn(async () => detail),
  };
}

describe("critical backend flows", () => {
  it("shares one GitHub refresh across concurrent Issue API requests", async () => {
    const database = openDatabase(":memory:");
    cleanups.push(() => database.close());
    createRepository(database);
    upsertIssuePage(database, "repo", [{
      nodeId: "issue-node",
      number: 7,
      title: "Issue",
      url: "https://github.com/owner/repo/issues/7",
      authorLogin: "owner",
      status: "open",
      commentsCount: 0,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-02T00:00:00.000Z",
      closedAt: null,
    }]);
    const detail: FetchedIssueDetail = {
      number: 7,
      title: "Issue",
      url: "https://github.com/owner/repo/issues/7",
      state: "open",
      authorLogin: "owner",
      commentsCount: 0,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-02T00:00:00.000Z",
      closedAt: null,
      body: "Fetched body",
      comments: [],
    };
    const github = provider(detail);
    const app = buildTestApp({
      database,
      timezone: "Asia/Shanghai",
      github,
      syncCoordinator: createSyncCoordinatorStub({
        start: () => { throw new Error("not used"); },
      }),
    });
    cleanups.push(() => app.close());

    const [first, second] = await Promise.all([
      app.inject({ method: "GET", url: "/api/repositories/repo/issues/7" }),
      app.inject({ method: "GET", url: "/api/repositories/repo/issues/7" }),
    ]);

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(first.json().detailBody).toBe("Fetched body");
    expect(github.fetchIssueDetail).toHaveBeenCalledTimes(1);
  });

  it("indexes an external Knowledge edit and records one new version", async () => {
    const database = openDatabase(":memory:");
    cleanups.push(() => database.close());
    const root = mkdtempSync(join(tmpdir(), "loongboard-knowledge-regression-"));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const path = join(root, "README.md");
    const initial = "---\nloongboard_id: doc_readme\n---\n\n# Readme\n\nInitial\n";
    writeFileSync(path, initial, "utf8");
    const controller = new KnowledgeController({
      database,
      knowledgePath: root,
      historyLimit: 10,
      chats: {} as never,
    });
    cleanups.push(() => controller.close());

    expect(controller.tree()).toHaveLength(1);
    const before = listDocumentVersions(database, "doc_readme", 10);
    const changed = initial.replace("Initial", "Changed");
    writeFileSync(path, changed, "utf8");

    expect(controller.readByPath("README.md").content).toBe(changed);
    const after = listDocumentVersions(database, "doc_readme", 10);
    expect(after).toHaveLength(before.length + 1);
    expect(after[0]?.source).toBe("external");
  });
});
