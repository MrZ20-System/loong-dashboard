import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createMaintenanceRun,
  getMaintenanceRun,
  openDatabase,
  previewRuntimeHistoryPurge,
  purgeRuntimeHistoryBatch,
  reconcileRepositories,
  updateRepositoryHistoryState,
  type ConfiguredRepository,
} from "../src/index.js";

const directories: string[] = [];

function databasePath(): string {
  const directory = mkdtempSync(join(tmpdir(), "loongboard-sync-retention-db-"));
  directories.push(directory);
  return join(directory, "loongboard.sqlite3");
}

function repository(key: string): ConfiguredRepository {
  return {
    key,
    name: key,
    github: `example/${key}`,
    path: `/workspace/${key}`,
    remote: "origin",
    defaultBranch: "main",
    worktreeSlots: 2,
  };
}

function withDatabase<T>(callback: (database: ReturnType<typeof openDatabase>) => T): T {
  const database = openDatabase(databasePath());
  try {
    return callback(database);
  } finally {
    database.close();
  }
}

function insertRun(
  database: ReturnType<typeof openDatabase>,
  id: string,
  repositoryId: string,
  requestedAt: string,
  status = "completed",
): void {
  database.prepare(`
    INSERT INTO repository_sync_runs
      (id, repository_id, kind, trigger, status, requested_at, selector_json)
    VALUES (?, ?, 'forward', 'manual', ?, ?, '{}')
  `).run(id, repositoryId, status, requestedAt);
}

function insertStreamAndTarget(
  database: ReturnType<typeof openDatabase>,
  runId: string,
  repositoryId: string,
  prNumber: number,
): void {
  database.prepare(`
    INSERT INTO repository_sync_run_streams (run_id, entity_kind, status)
    VALUES (?, 'pull_request', 'completed')
  `).run(runId);
  database.prepare(`
    INSERT INTO repository_sync_run_targets
      (run_id, repository_id, pr_number, head_sha, reason)
    VALUES (?, ?, ?, ?, 'history')
  `).run(runId, repositoryId, prNumber, "a".repeat(40));
}

function count(database: ReturnType<typeof openDatabase>, table: string): number {
  return Number(database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).pluck().get());
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("sync-run retention", () => {
  it("keeps the newest 100 old runs and purges only older runs", () => {
    withDatabase((database) => {
      reconcileRepositories(database, [repository("repo")]);
      for (let index = 0; index < 105; index += 1) {
        insertRun(
          database,
          `old-${String(index).padStart(3, "0")}`,
          "repo",
          "2026-01-01T00:00:00.000Z",
        );
      }

      const preview = previewRuntimeHistoryPurge(database, {
        repositoryId: "repo",
        cutoff: "2026-08-12T00:00:00Z",
        asOf: "2026-09-11T00:00:00Z",
      });
      expect(preview.runCount).toBe(5);
      expect(preview.protectedRunCount).toBe(100);

      const result = purgeRuntimeHistoryBatch(database, {
        repositoryId: "repo",
        cutoff: "2026-08-12T00:00:00Z",
      });
      expect(result).toMatchObject({
        runsDeleted: 5,
        streamsDeleted: 0,
        targetsDeleted: 0,
        hasMore: false,
        batchSize: 250,
      });
      expect(count(database, "repository_sync_runs")).toBe(100);
      expect(
        database.prepare(
          "SELECT id FROM repository_sync_runs WHERE id = 'old-004'",
        ).get(),
      ).toBeUndefined();
      expect(
        database.prepare(
          "SELECT id FROM repository_sync_runs WHERE id = 'old-005'",
        ).get(),
      ).toEqual({ id: "old-005" });
    });
  });

  it("protects active runs, current-window runs, last-run pointers, and the cutoff boundary", () => {
    withDatabase((database) => {
      reconcileRepositories(database, [repository("repo")]);
      for (let index = 0; index < 101; index += 1) {
        insertRun(
          database,
          `recent-${String(index).padStart(3, "0")}`,
          "repo",
          "2026-08-20T00:00:00.000Z",
        );
      }
      insertRun(database, "deletable", "repo", "2026-01-01T00:00:00.000Z");
      insertRun(database, "history-pointer", "repo", "2026-01-01T00:00:00.000Z");
      insertRun(database, "sync-pointer", "repo", "2026-01-01T00:00:00.000Z");
      insertRun(database, "queued", "repo", "2026-01-01T00:00:00.000Z", "queued");
      insertRun(database, "running", "repo", "2026-01-01T00:00:00.000Z", "running");
      insertRun(database, "at-cutoff", "repo", "2026-08-12T00:00:00.000Z");

      updateRepositoryHistoryState(database, "repo", "pull_request", {
        lastRunId: "history-pointer",
      });
      // The current production schema has no repository_sync_state.last_run_id.
      // Exercise the optional protection branch so a future additive schema is
      // also covered without changing migration 012 here.
      database.exec("ALTER TABLE repository_sync_state ADD COLUMN last_run_id TEXT");
      database.prepare(`
        UPDATE repository_sync_state
        SET last_run_id = ?
        WHERE repository_id = 'repo' AND entity_kind = 'pull_request'
      `).run("sync-pointer");

      const preview = previewRuntimeHistoryPurge(database, {
        repositoryId: "repo",
        cutoff: "2026-08-12T00:00:00Z",
        asOf: "2026-09-11T00:00:00Z",
      });
      expect(preview).toMatchObject({
        runCount: 1,
        protectedRunCount: 4,
        queuedOrRunningCount: 2,
      });

      const result = purgeRuntimeHistoryBatch(database, {
        repositoryId: "repo",
        cutoff: "2026-08-12T00:00:00Z",
      });
      expect(result.runsDeleted).toBe(1);
      for (const id of [
        "recent-000",
        "history-pointer",
        "sync-pointer",
        "queued",
        "running",
        "at-cutoff",
      ]) {
        expect(database.prepare("SELECT id FROM repository_sync_runs WHERE id = ?").get(id))
          .toEqual({ id });
      }
      expect(database.prepare("SELECT id FROM repository_sync_runs WHERE id = 'deletable'").get())
        .toBeUndefined();
    });
  });

  it("uses FK cascades for children and records the deleted run count", () => {
    withDatabase((database) => {
      reconcileRepositories(database, [repository("repo")]);
      for (let index = 0; index < 101; index += 1) {
        const id = `cascade-${String(index).padStart(3, "0")}`;
        insertRun(database, id, "repo", "2026-01-01T00:00:00.000Z");
        if (index === 0) insertStreamAndTarget(database, id, "repo", 1);
      }
      const maintenance = createMaintenanceRun(database, {
        id: "maintenance-purge",
        repositoryId: "repo",
        kind: "purge_runtime_history",
        trigger: "manual",
        cutoff: "2026-08-12T00:00:00Z",
        selector: { source: "test" },
      });

      const result = purgeRuntimeHistoryBatch(database, {
        repositoryId: "repo",
        cutoff: "2026-08-12T00:00:00Z",
        maintenanceRunId: maintenance.id,
      });
      expect(result).toMatchObject({
        runsDeleted: 1,
        streamsDeleted: 1,
        targetsDeleted: 1,
      });
      expect(database.prepare("SELECT id FROM repository_sync_runs WHERE id = 'cascade-000'").get())
        .toBeUndefined();
      expect(count(database, "repository_sync_run_streams")).toBe(0);
      expect(count(database, "repository_sync_run_targets")).toBe(0);
      expect(getMaintenanceRun(database, maintenance.id)).toMatchObject({
        selector: { source: "test", runsDeleted: 1 },
      });
    });
  });

  it("deletes in bounded batches and never crosses repository boundaries", () => {
    withDatabase((database) => {
      reconcileRepositories(database, [repository("repo-a"), repository("repo-b")]);
      for (let index = 0; index < 352; index += 1) {
        insertRun(
          database,
          `a-${String(index).padStart(3, "0")}`,
          "repo-a",
          "2026-01-01T00:00:00.000Z",
        );
      }
      for (let index = 0; index < 101; index += 1) {
        insertRun(
          database,
          `b-${String(index).padStart(3, "0")}`,
          "repo-b",
          "2026-01-01T00:00:00.000Z",
        );
      }

      const first = purgeRuntimeHistoryBatch(database, {
        repositoryId: "repo-a",
        cutoff: "2026-08-12T00:00:00Z",
      });
      expect(first).toMatchObject({ runsDeleted: 250, hasMore: true, batchSize: 250 });

      const second = purgeRuntimeHistoryBatch(database, {
        repositoryId: "repo-a",
        cutoff: "2026-08-12T00:00:00Z",
      });
      expect(second).toMatchObject({ runsDeleted: 2, hasMore: false, batchSize: 250 });
      expect(
        database.prepare("SELECT COUNT(*) AS count FROM repository_sync_runs WHERE repository_id = ?")
          .pluck().get("repo-a"),
      ).toBe(100);
      expect(
        database.prepare("SELECT COUNT(*) AS count FROM repository_sync_runs WHERE repository_id = ?")
          .pluck().get("repo-b"),
      ).toBe(101);
    });
  });
});
