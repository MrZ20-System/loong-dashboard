import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  getMaintenanceRun,
  getPullRequestDetail,
  openDatabase,
  reconcileRepositories,
  upsertPullRequestPage,
  type ConfiguredRepository,
  type DatabaseClient,
  type PullRequestMetadata,
} from "@loongboard/database";
import { afterEach, describe, expect, it } from "vitest";

import { MetadataMaintenanceService } from "../src/metadata-maintenance.js";

const fixtures: Array<{ database: DatabaseClient; root: string }> = [];

function fixture(): DatabaseClient {
  const root = mkdtempSync(join(tmpdir(), "loongboard-maintenance-"));
  const database = openDatabase(join(root, "state.sqlite3"));
  fixtures.push({ database, root });
  const repository: ConfiguredRepository = {
    key: "repo",
    name: "Repository",
    github: "example/repo",
    path: join(root, "repo"),
    remote: "origin",
    defaultBranch: "main",
    worktreeSlots: 1,
  };
  reconcileRepositories(database, [repository]);
  return database;
}

function pullRequest(number: number): PullRequestMetadata {
  return {
    nodeId: `node-${number}`,
    number,
    title: `Pull request ${number}`,
    url: `https://github.com/example/repo/pull/${number}`,
    authorLogin: "author",
    stateRaw: "CLOSED",
    status: "closed",
    isDraft: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
    closedAt: "2026-08-01T00:00:00.000Z",
    mergedAt: null,
    baseRefName: "main",
    headRefName: `branch-${number}`,
    headSha: String(number).padStart(40, "0"),
    additions: 1,
    deletions: 1,
    changedFilesCount: 1,
    detailBody: "cached body",
  };
}

afterEach(() => {
  for (const fixture of fixtures.splice(0)) {
    if (fixture.database.open) fixture.database.close();
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

describe("MetadataMaintenanceService", () => {
  it("uses the server timezone for preview and returns a queued run before batches start", async () => {
    const database = fixture();
    upsertPullRequestPage(database, "repo", [pullRequest(1)]);
    const service = new MetadataMaintenanceService({
      database,
      calendarTimeZone: "Asia/Shanghai",
      now: () => new Date("2026-09-11T00:00:00.000Z"),
    });

    const preview = service.preview("repo", {
      date: "2026-09-02",
      includeMergedPrs: false,
      includeClosedPrs: true,
      includeClosedIssues: false,
    });
    expect(preview).toMatchObject({
      date: "2026-09-02",
      calendarTimeZone: "Asia/Shanghai",
      cutoff: "2026-09-01T16:00:00.000Z",
      closedPrCount: 1,
      mergedPrCount: 0,
      closedIssueCount: 0,
    });

    const started = service.start("repo", {
      date: "2026-09-02",
      includeMergedPrs: false,
      includeClosedPrs: true,
      includeClosedIssues: false,
      prune: false,
    });
    expect(started.run.status).toBe("queued");
    expect(getMaintenanceRun(database, started.run.id)?.status).toBe("queued");
    const completed = await started.completion;
    expect(completed).toMatchObject({
      status: "completed",
      kind: "archive",
      prCount: 1,
      issueCount: 0,
    });
    expect(getPullRequestDetail(database, "repo", 1)?.archivedAt).not.toBeNull();
    await service.close();
  });

  it("interrupts a queued run during close without leaving a pending promise", async () => {
    const database = fixture();
    const service = new MetadataMaintenanceService({
      database,
      calendarTimeZone: "UTC",
      isSyncActive: () => true,
    });
    const started = service.start("repo", {
      date: "2026-09-02",
      includeMergedPrs: true,
      includeClosedPrs: true,
      includeClosedIssues: true,
      prune: true,
    });

    const closing = service.close();
    await expect(started.completion).resolves.toMatchObject({ status: "interrupted" });
    await expect(closing).resolves.toBeUndefined();
    expect(getMaintenanceRun(database, started.run.id)?.status).toBe("interrupted");
  });

  it("serializes queued runs for one repository", async () => {
    const database = fixture();
    upsertPullRequestPage(database, "repo", [pullRequest(1)]);
    const admission: boolean[] = [];
    const service = new MetadataMaintenanceService({
      database,
      calendarTimeZone: "UTC",
      setRepositoryMaintenanceActive: (_repositoryId, active) => admission.push(active),
    });
    const input = {
      date: "2026-09-02" as const,
      includeMergedPrs: false,
      includeClosedPrs: true,
      includeClosedIssues: false,
      prune: false,
    };
    const first = service.start("repo", input);
    const second = service.start("repo", input);

    expect(first.run.status).toBe("queued");
    expect(second.run.status).toBe("queued");
    await expect(first.completion).resolves.toMatchObject({ status: "completed", prCount: 1 });
    await expect(second.completion).resolves.toMatchObject({ status: "completed", prCount: 0 });
    expect(admission).toEqual([true, false, true, false]);
    await service.close();
  });
});
