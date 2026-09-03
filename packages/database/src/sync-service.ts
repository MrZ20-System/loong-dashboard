import { randomUUID } from "node:crypto";

import type Database from "better-sqlite3";

import {
  requireRepository,
  RepositoryNotFoundError,
} from "./repository-service.js";
import {
  type DatabaseClient,
  type EntityKind,
  type RepositorySyncState,
  type RepositorySyncStatus,
  type SyncRun,
  type SyncStatus,
  type SyncStreamUpdate,
} from "./types.js";

const ENTITY_KINDS = ["pull_request", "issue"] as const;

export class SyncAlreadyRunningError extends Error {
  readonly code = "SYNC_ALREADY_RUNNING" as const;

  constructor(repositoryId: string) {
    super(`A sync is already running for repository: ${repositoryId}`);
    this.name = "SyncAlreadyRunningError";
  }
}

export class InvalidSyncTransitionError extends Error {
  readonly code = "INVALID_SYNC_TRANSITION" as const;

  constructor(repositoryId: string, entityKind: EntityKind, message: string) {
    super(`${message}: ${repositoryId}/${entityKind}`);
    this.name = "InvalidSyncTransitionError";
  }
}

function timestamp(value?: Date | string): string {
  if (value instanceof Date) {
    if (!Number.isFinite(value.getTime())) throw new Error("Invalid timestamp");
    return value.toISOString();
  }
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (!Number.isFinite(parsed)) throw new Error(`Invalid timestamp: ${value}`);
    return new Date(parsed).toISOString();
  }
  return new Date().toISOString();
}

function mapSyncState(row: Record<string, unknown>): RepositorySyncState {
  return {
    repositoryId: row.repository_id as string,
    entityKind: row.entity_kind as EntityKind,
    watermarkUpdatedAt: (row.watermark_updated_at as string | null) ?? null,
    lastAttemptAt: (row.last_attempt_at as string | null) ?? null,
    lastSuccessAt: (row.last_success_at as string | null) ?? null,
    status: row.status as SyncStatus,
    lastError: (row.last_error as string | null) ?? null,
    rateLimitRemaining: (row.rate_limit_remaining as number | null) ?? null,
    rateLimitResetAt: (row.rate_limit_reset_at as string | null) ?? null,
  };
}

function insertMissingSyncRows(database: DatabaseClient, repositoryId: string): void {
  const statement = database.prepare(
    `INSERT INTO repository_sync_state (repository_id, entity_kind, status)
     VALUES (?, ?, 'idle')
     ON CONFLICT(repository_id, entity_kind) DO NOTHING`,
  );
  for (const entityKind of ENTITY_KINDS) statement.run(repositoryId, entityKind);
}

function getSyncState(
  database: DatabaseClient,
  repositoryId: string,
  entityKind: EntityKind,
): RepositorySyncState | null {
  const row = database
    .prepare(
      "SELECT * FROM repository_sync_state WHERE repository_id = ? AND entity_kind = ?",
    )
    .get(repositoryId, entityKind) as Record<string, unknown> | undefined;
  return row === undefined ? null : mapSyncState(row);
}

function requireSyncState(
  database: DatabaseClient,
  repositoryId: string,
  entityKind: EntityKind,
): RepositorySyncState {
  const state = getSyncState(database, repositoryId, entityKind);
  if (state === null) {
    throw new Error(`Missing sync state for repository/entity: ${repositoryId}/${entityKind}`);
  }
  return state;
}

function normalizeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (message.trim().length === 0) return "Sync failed";
  return message;
}

export interface BeginStreamInput {
  repositoryId: string;
  entityKind: EntityKind;
  attemptStartedAt?: Date | string;
}

/** Start one stream when it is not already running. */
export function startSyncStream(
  database: DatabaseClient,
  input: BeginStreamInput,
): RepositorySyncState {
  const startedAt = timestamp(input.attemptStartedAt);
  requireRepository(database, input.repositoryId);
  insertMissingSyncRows(database, input.repositoryId);
  const existing = requireSyncState(database, input.repositoryId, input.entityKind);
  if (existing.status === "running") {
    throw new SyncAlreadyRunningError(input.repositoryId);
  }

  database
    .prepare(
      `UPDATE repository_sync_state SET
        status = 'running', last_attempt_at = ?, last_error = NULL
       WHERE repository_id = ? AND entity_kind = ?`,
    )
    .run(startedAt, input.repositoryId, input.entityKind);
  return requireSyncState(database, input.repositoryId, input.entityKind);
}

/**
 * Start the two metadata streams as one repository sync. The transaction
 * makes the overlap check and both running transitions atomic.
 */
export function startRepositorySync(
  database: DatabaseClient,
  repositoryId: string,
  attemptStartedAt?: Date | string,
): SyncRun {
  const startedAt = timestamp(attemptStartedAt);
  requireRepository(database, repositoryId);
  const syncRunId = randomUUID();

  database.transaction(() => {
    insertMissingSyncRows(database, repositoryId);
    const running = database
      .prepare(
        `SELECT 1 FROM repository_sync_state
         WHERE repository_id = ? AND status = 'running' LIMIT 1`,
      )
      .get(repositoryId);
    if (running !== undefined) throw new SyncAlreadyRunningError(repositoryId);

    database
      .prepare(
        `UPDATE repository_sync_state SET
          status = 'running', last_attempt_at = ?, last_error = NULL
         WHERE repository_id = ? AND entity_kind IN ('pull_request', 'issue')`,
      )
      .run(startedAt, repositoryId);
  })();

  return { repositoryId, syncRunId, startedAt };
}

export interface CompleteStreamInput extends SyncStreamUpdate {
  repositoryId: string;
  entityKind: EntityKind;
}

/** Mark a running stream successful and advance its watermark monotonically. */
export function completeSyncStream(
  database: DatabaseClient,
  input: CompleteStreamInput,
): RepositorySyncState {
  const state = requireSyncState(database, input.repositoryId, input.entityKind);
  if (state.status !== "running") {
    throw new InvalidSyncTransitionError(
      input.repositoryId,
      input.entityKind,
      "Only a running sync stream can complete",
    );
  }
  // The completion boundary must use the timestamp persisted by the start
  // transition.  Accepting a caller-supplied attempt start here would let a
  // provider move the incremental-sync watermark independently of the actual
  // sync attempt.
  const attemptStartedAt = state.lastAttemptAt;
  if (attemptStartedAt === null) {
    throw new InvalidSyncTransitionError(
      input.repositoryId,
      input.entityKind,
      "A running sync stream has no persisted attempt timestamp",
    );
  }
  const completedAt = timestamp(input.completedAt);
  const nextRateLimitReset =
    input.rateLimitResetAt === undefined
      ? state.rateLimitResetAt
      : input.rateLimitResetAt === null
        ? null
        : timestamp(input.rateLimitResetAt);

  database
    .prepare(
      `UPDATE repository_sync_state SET
        watermark_updated_at = CASE
          WHEN watermark_updated_at IS NULL OR watermark_updated_at < ? THEN ?
          ELSE watermark_updated_at
        END,
        last_success_at = ?, status = 'idle', last_error = NULL,
        rate_limit_remaining = ?, rate_limit_reset_at = ?
       WHERE repository_id = ? AND entity_kind = ?`,
    )
    .run(
      attemptStartedAt,
      attemptStartedAt,
      completedAt,
      input.rateLimitRemaining === undefined
        ? state.rateLimitRemaining
        : input.rateLimitRemaining,
      nextRateLimitReset,
      input.repositoryId,
      input.entityKind,
    );

  return requireSyncState(database, input.repositoryId, input.entityKind);
}

export interface FailStreamInput {
  repositoryId: string;
  entityKind: EntityKind;
  error: unknown;
  failedAt?: Date | string;
}

/** Fail a running stream while preserving its last successful watermark. */
export function failSyncStream(
  database: DatabaseClient,
  input: FailStreamInput,
): RepositorySyncState {
  const state = requireSyncState(database, input.repositoryId, input.entityKind);
  if (state.status !== "running") {
    throw new InvalidSyncTransitionError(
      input.repositoryId,
      input.entityKind,
      "Only a running sync stream can fail",
    );
  }

  database
    .prepare(
      `UPDATE repository_sync_state SET
        status = 'failed', last_error = ?,
        last_attempt_at = COALESCE(last_attempt_at, ?)
       WHERE repository_id = ? AND entity_kind = ?`,
    )
    .run(
      normalizeError(input.error),
      timestamp(input.failedAt),
      input.repositoryId,
      input.entityKind,
    );
  return requireSyncState(database, input.repositoryId, input.entityKind);
}

/**
 * Recover states that were left running by a process interruption. This is
 * called for every database opened by the Server and is also public for tests
 * and controlled startup flows.
 */
export function recoverInterruptedSyncStates(
  database: DatabaseClient,
  recoveredAt?: Date | string,
  reason = "Sync interrupted before completion",
): number {
  const recoveryTimestamp = timestamp(recoveredAt);
  const result = database
    .prepare(
      `UPDATE repository_sync_state SET
        status = 'failed',
        last_error = ?,
        last_attempt_at = COALESCE(last_attempt_at, ?)
       WHERE status = 'running'`,
    )
    .run(reason, recoveryTimestamp);
  return result.changes;
}

export function getRepositorySyncState(
  database: DatabaseClient,
  repositoryId: string,
  entityKind: EntityKind,
): RepositorySyncState {
  requireRepository(database, repositoryId);
  insertMissingSyncRows(database, repositoryId);
  return requireSyncState(database, repositoryId, entityKind);
}

export function getRepositorySyncStatus(
  database: DatabaseClient,
  repositoryId: string,
): RepositorySyncStatus {
  requireRepository(database, repositoryId);
  insertMissingSyncRows(database, repositoryId);
  const pullRequests = requireSyncState(database, repositoryId, "pull_request");
  const issues = requireSyncState(database, repositoryId, "issue");
  let status: SyncStatus = "idle";
  if (pullRequests.status === "running" || issues.status === "running") {
    status = "running";
  } else if (pullRequests.status === "failed" || issues.status === "failed") {
    status = "failed";
  }
  return { repositoryId, status, pullRequests, issues };
}

export { RepositoryNotFoundError };
