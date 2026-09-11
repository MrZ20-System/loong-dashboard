import { afterEach, describe, expect, it } from "vitest";
import {
  cleanupDatabaseDirectories,
  databasePath,
  repository,
  withDatabase,
} from "./support.js";
import {
  beginQueuedForwardSync,
  completeSyncStream,
  createSyncRun,
  failSyncStream,
  getRepositorySyncState,
  getRepositorySyncStatus,
  getSyncRun,
  markSyncRunStarted,
  openDatabase,
  reconcileRepositories,
} from "../src/index.js";

afterEach(cleanupDatabaseDirectories);

describe("sync state persistence", () => {
  it("transitions streams, rejects overlap, and preserves a failure watermark", () => {
    withDatabase((database) => {
      reconcileRepositories(database, [repository("alpha")], "2026-09-03T00:00:00.000Z");
      const run = createSyncRun(database, {
        repositoryId: "alpha",
        kind: "forward",
        attemptStartedAt: "2026-09-03T01:00:00.000Z",
      });
      beginQueuedForwardSync(database, {
        repositoryId: "alpha",
        runId: run.syncRunId,
        startedAt: "2026-09-03T01:00:00.000Z",
      });
      expect(run).toEqual({
        repositoryId: "alpha",
        syncRunId: expect.any(String),
        startedAt: "2026-09-03T01:00:00.000Z",
        kind: "forward",
        trigger: "manual",
      });
      const overlap = createSyncRun(database, {
        repositoryId: "alpha",
        kind: "forward",
      });
      expect(() => beginQueuedForwardSync(database, {
        repositoryId: "alpha",
        runId: overlap.syncRunId,
      })).toThrow(/already running/);

      completeSyncStream(database, {
        repositoryId: "alpha",
        entityKind: "pull_request",
        completedAt: "2026-09-03T01:01:00.000Z",
      });
      failSyncStream(database, {
        repositoryId: "alpha",
        entityKind: "issue",
        error: new Error("GitHub unavailable"),
        failedAt: "2026-09-03T01:02:00.000Z",
      });
      expect(getRepositorySyncStatus(database, "alpha")).toEqual({
        repositoryId: "alpha",
        status: "failed",
        pullRequests: expect.objectContaining({
          status: "idle",
          watermarkUpdatedAt: "2026-09-03T01:00:00.000Z",
          lastSuccessAt: "2026-09-03T01:01:00.000Z",
        }),
        issues: expect.objectContaining({
          status: "failed",
          watermarkUpdatedAt: null,
          lastSuccessAt: null,
          lastAttemptAt: "2026-09-03T01:00:00.000Z",
          lastError: "GitHub unavailable",
        }),
      });

      const second = createSyncRun(database, {
        repositoryId: "alpha",
        kind: "forward",
        attemptStartedAt: "2026-09-03T02:00:00.000Z",
      });
      beginQueuedForwardSync(database, {
        repositoryId: "alpha",
        runId: second.syncRunId,
        startedAt: "2026-09-03T02:00:00.000Z",
      });
      failSyncStream(database, {
        repositoryId: "alpha",
        entityKind: "pull_request",
        error: "second failure",
      });
      expect(getRepositorySyncState(database, "alpha", "pull_request").watermarkUpdatedAt).toBe(
        "2026-09-03T01:00:00.000Z",
      );
    });
  });

  it("recovers running states when a database is reopened", () => {
    const path = databasePath();
    const first = openDatabase(path);
    reconcileRepositories(first, [repository("alpha")], "2026-09-03T00:00:00.000Z");
    const run = createSyncRun(first, {
      repositoryId: "alpha",
      kind: "forward",
      attemptStartedAt: "2026-09-03T01:00:00.000Z",
    });
    beginQueuedForwardSync(first, {
      repositoryId: "alpha",
      runId: run.syncRunId,
      startedAt: "2026-09-03T01:00:00.000Z",
    });
    first.close();

    const reopened = openDatabase(path);
    try {
      expect(getRepositorySyncStatus(reopened, "alpha")).toEqual(
        expect.objectContaining({
          status: "failed",
          pullRequests: expect.objectContaining({
            status: "failed",
            lastAttemptAt: "2026-09-03T01:00:00.000Z",
            lastError: "Sync interrupted before completion",
          }),
          issues: expect.objectContaining({ status: "failed" }),
        }),
      );
    } finally {
      reopened.close();
    }
  });

  it("rejects creating a sync run for a disabled repository", () => {
    withDatabase((database) => {
      reconcileRepositories(database, [repository("repo")]);
      reconcileRepositories(database, []);

      expect(() => createSyncRun(database, {
        repositoryId: "repo",
        kind: "forward",
      })).toThrow(/Repository is missing or disabled/);
    });
  });

  it("uses the persisted attempt timestamp when completing a stream", () => {
    withDatabase((database) => {
      reconcileRepositories(database, [repository("repo")]);
      const run = createSyncRun(database, {
        repositoryId: "repo",
        kind: "forward",
        attemptStartedAt: "2026-09-03T01:00:00.000Z",
      });
      beginQueuedForwardSync(database, {
        repositoryId: "repo",
        runId: run.syncRunId,
        startedAt: "2026-09-03T01:00:00.000Z",
      });

      completeSyncStream(database, {
        repositoryId: "repo",
        entityKind: "pull_request",
        completedAt: "2026-09-03T01:01:00.000Z",
        // This is deliberately an untyped external payload. Completion must
        // ignore it and use the persisted last_attempt_at value.
        attemptStartedAt: "2099-01-01T00:00:00.000Z",
      } as never);

      expect(getRepositorySyncState(database, "repo", "pull_request")).toEqual(
        expect.objectContaining({
          watermarkUpdatedAt: "2026-09-03T01:00:00.000Z",
          lastAttemptAt: "2026-09-03T01:00:00.000Z",
        }),
      );
    });
  });

  it("recovers durable queued/running runs as interrupted without deleting progress", () => {
    const path = databasePath();
    const first = openDatabase(path);
    reconcileRepositories(first, [repository("alpha")], "2026-09-03T00:00:00.000Z");
    const run = createSyncRun(first, {
      repositoryId: "alpha",
      kind: "history",
      trigger: "manual",
      entityKinds: ["pull_request", "issue"],
    });
    markSyncRunStarted(first, run.syncRunId, "2026-09-03T01:00:00.000Z");
    first
      .prepare("UPDATE repository_sync_run_streams SET items_seen = 3 WHERE run_id = ? AND entity_kind = 'pull_request'")
      .run(run.syncRunId);
    first.close();

    const reopened = openDatabase(path);
    try {
      expect(getSyncRun(reopened, run.syncRunId)).toMatchObject({
        status: "interrupted",
        streams: expect.arrayContaining([
          expect.objectContaining({ entityKind: "pull_request", status: "interrupted", itemsSeen: 3 }),
          expect.objectContaining({ entityKind: "issue", status: "interrupted" }),
        ]),
      });
    } finally {
      reopened.close();
    }
  });
});
