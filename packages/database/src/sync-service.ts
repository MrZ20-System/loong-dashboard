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
  type RepositoryHistoryState,
  type SyncRun,
  type SyncRunKind,
  type SyncRunRecord,
  type SyncRunStatus,
  type SyncRunStreamRecord,
  type SyncRunTrigger,
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

export class SyncRunNotFoundError extends Error {
  readonly code = "SYNC_RUN_NOT_FOUND" as const;

  constructor(runId: string) {
    super(`Sync run not found: ${runId}`);
    this.name = "SyncRunNotFoundError";
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

export interface CreateSyncRunInput {
  repositoryId: string;
  kind: SyncRunKind;
  trigger?: SyncRunTrigger;
  selector?: Record<string, unknown>;
  attemptStartedAt?: Date | string;
  entityKinds?: readonly EntityKind[];
  /** Existing successful watermarks copied into the child stream rows. */
  watermarkBefore?: Partial<Record<EntityKind, string | null>>;
}

function normalizeJson(value: Record<string, unknown> | undefined): string {
  return JSON.stringify(value ?? {});
}

function parseJson(value: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function normalizeRunError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.trim().length === 0 ? "Sync failed" : message;
}

function runTimestamp(value?: Date | string): string {
  return timestamp(value);
}

function mapSyncRunStream(row: Record<string, unknown>): SyncRunStreamRecord {
  return {
    runId: row.run_id as string,
    entityKind: row.entity_kind as EntityKind,
    status: row.status as SyncRunStatus,
    pagesFetched: Number(row.pages_fetched ?? 0),
    itemsSeen: Number(row.items_seen ?? 0),
    itemsWritten: Number(row.items_written ?? 0),
    watermarkBefore: (row.watermark_before as string | null) ?? null,
    watermarkAfter: (row.watermark_after as string | null) ?? null,
    rateLimitRemaining: (row.rate_limit_remaining as number | null) ?? null,
    startedAt: (row.started_at as string | null) ?? null,
    finishedAt: (row.finished_at as string | null) ?? null,
    error: (row.error as string | null) ?? null,
  };
}

function readSyncRun(database: DatabaseClient, runId: string): SyncRunRecord | null {
  const row = database
    .prepare("SELECT * FROM repository_sync_runs WHERE id = ?")
    .get(runId) as Record<string, unknown> | undefined;
  if (row === undefined) return null;
  const streams = database
    .prepare(
      `SELECT * FROM repository_sync_run_streams
       WHERE run_id = ? ORDER BY entity_kind ASC`,
    )
    .all(runId) as Array<Record<string, unknown>>;
  return mapSyncRunRecord(row, streams.map(mapSyncRunStream));
}

function mapSyncRunRecord(
  row: Record<string, unknown>,
  streams: SyncRunStreamRecord[],
): SyncRunRecord {
  return {
    syncRunId: row.id as string,
    repositoryId: row.repository_id as string,
    kind: row.kind as SyncRunKind,
    trigger: row.trigger as SyncRunTrigger,
    status: row.status as SyncRunStatus,
    requestedAt: row.requested_at as string,
    startedAt: (row.started_at as string | null) ?? null,
    finishedAt: (row.finished_at as string | null) ?? null,
    selector: parseJson(row.selector_json as string),
    itemsSeen: Number(row.items_seen ?? 0),
    itemsWritten: Number(row.items_written ?? 0),
    error: (row.error as string | null) ?? null,
    streams,
  };
}

/** Create a durable run and its per-entity stream rows before any provider call. */
export function createSyncRun(
  database: DatabaseClient,
  input: CreateSyncRunInput,
): SyncRun {
  const requestedAt = runTimestamp(input.attemptStartedAt);
  const runId = randomUUID();
  const entityKinds = input.entityKinds ?? ENTITY_KINDS;
  const trigger = input.trigger ?? "manual";
  requireRepository(database, input.repositoryId);
  database.transaction(() => {
    database
      .prepare(
        `INSERT INTO repository_sync_runs
           (id, repository_id, kind, trigger, status, requested_at, selector_json)
         VALUES (?, ?, ?, ?, 'queued', ?, ?)`,
      )
      .run(
        runId,
        input.repositoryId,
        input.kind,
        trigger,
        requestedAt,
        normalizeJson(input.selector),
      );
    const insertStream = database.prepare(
      `INSERT INTO repository_sync_run_streams
         (run_id, entity_kind, status, watermark_before)
       VALUES (?, ?, 'queued', ?)`,
    );
    for (const entityKind of entityKinds) {
      insertStream.run(
        runId,
        entityKind,
        input.watermarkBefore?.[entityKind] ?? null,
      );
    }
  })();
  return {
    repositoryId: input.repositoryId,
    syncRunId: runId,
    startedAt: requestedAt,
    kind: input.kind,
    trigger,
  };
}

/** Move a queued run and all of its streams to running at admission time. */
export function markSyncRunStarted(
  database: DatabaseClient,
  runId: string,
  startedAt?: Date | string,
): SyncRunRecord {
  const value = runTimestamp(startedAt);
  const result = database
    .prepare(
      `UPDATE repository_sync_runs
       SET status = 'running', started_at = COALESCE(started_at, ?)
       WHERE id = ? AND status = 'queued'`,
    )
    .run(value, runId);
  if (result.changes === 0) {
    const existing = readSyncRun(database, runId);
    if (existing === null) throw new Error(`Sync run not found: ${runId}`);
    return existing;
  }
  database
    .prepare(
      `UPDATE repository_sync_run_streams
       SET status = 'running', started_at = COALESCE(started_at, ?)
       WHERE run_id = ? AND status = 'queued'`,
    )
    .run(value, runId);
  return readSyncRun(database, runId)!;
}

/**
 * Admit a queued forward run atomically with its repository stream state.
 * Queued runs are intentionally invisible to the forward watermark/state
 * until the per-repository coordinator has selected them for execution.
 */
export function beginQueuedForwardSync(
  database: DatabaseClient,
  input: {
    repositoryId: string;
    runId: string;
    startedAt?: Date | string;
  },
): SyncRunRecord {
  const value = runTimestamp(input.startedAt);
  requireRepository(database, input.repositoryId);
  database.transaction(() => {
    const run = readSyncRun(database, input.runId);
    if (run === null || run.repositoryId !== input.repositoryId || run.kind !== "forward") {
      throw new InvalidSyncTransitionError(
        input.runId,
        "pull_request",
        "Queued forward sync run is missing or belongs to another repository",
      );
    }
    if (run.status !== "queued") {
      throw new InvalidSyncTransitionError(
        input.runId,
        "pull_request",
        "Queued forward sync run is no longer queued",
      );
    }
    insertMissingSyncRows(database, input.repositoryId);
    const running = database
      .prepare(
        `SELECT 1 FROM repository_sync_state
         WHERE repository_id = ? AND status = 'running' LIMIT 1`,
      )
      .get(input.repositoryId);
    if (running !== undefined) throw new SyncAlreadyRunningError(input.repositoryId);

    database
      .prepare(
        `UPDATE repository_sync_state SET
          status = 'running', last_attempt_at = ?, last_error = NULL
         WHERE repository_id = ? AND entity_kind IN ('pull_request', 'issue')`,
      )
      .run(value, input.repositoryId);
    database
      .prepare(
        `UPDATE repository_sync_runs
         SET status = 'running', started_at = COALESCE(started_at, ?)
         WHERE id = ? AND status = 'queued'`,
      )
      .run(value, input.runId);
    database
      .prepare(
        `UPDATE repository_sync_run_streams
         SET status = 'running', started_at = COALESCE(started_at, ?)
         WHERE run_id = ? AND status = 'queued'`,
      )
      .run(value, input.runId);
  })();
  return getSyncRun(database, input.runId);
}

/** Mark a not-yet-admitted run interrupted while preserving durable history state. */
export function interruptSyncRun(
  database: DatabaseClient,
  runId: string,
  interruptedAt?: Date | string,
  reason = "Sync cancelled before admission",
): SyncRunRecord {
  const at = runTimestamp(interruptedAt);
  const existing = getSyncRun(database, runId);
  if (existing.status === "queued" || existing.status === "running") {
    database.transaction(() => {
      database
        .prepare(
          `UPDATE repository_sync_run_streams
           SET status = 'interrupted', finished_at = ?, error = ?
           WHERE run_id = ? AND status IN ('queued', 'running')`,
        )
        .run(at, reason, runId);
      database
        .prepare(
          `UPDATE repository_sync_runs
           SET status = 'interrupted', finished_at = ?, error = ?
           WHERE id = ? AND status IN ('queued', 'running')`,
        )
        .run(at, reason, runId);
    })();
  }
  return getSyncRun(database, runId);
}

export interface SyncRunPageUpdate {
  entityKind: EntityKind;
  pagesFetched?: number;
  itemsSeen?: number;
  itemsWritten?: number;
  rateLimitRemaining?: number | null;
}

export interface SyncRunTargetInput {
  repositoryId: string;
  prNumber: number;
  headSha: string;
  reason: "new" | "head_changed" | "retry" | "history" | "fetch_pr";
}

export function recordSyncRunTarget(
  database: DatabaseClient,
  runId: string,
  input: SyncRunTargetInput,
): void {
  database
    .prepare(
      `INSERT INTO repository_sync_run_targets
         (run_id, repository_id, pr_number, head_sha, reason)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(run_id, repository_id, pr_number) DO UPDATE SET
         head_sha = excluded.head_sha, reason = excluded.reason`,
    )
    .run(runId, input.repositoryId, input.prNumber, input.headSha, input.reason);
}

export function listSyncRunTargets(
  database: DatabaseClient,
  runId: string,
): Array<{ repositoryId: string; number: number; headSha: string; reason: SyncRunTargetInput["reason"] }> {
  return database
    .prepare(
      `SELECT repository_id, pr_number, head_sha, reason
       FROM repository_sync_run_targets WHERE run_id = ? ORDER BY pr_number ASC`,
    )
    .all(runId)
    .map((row) => {
      const value = row as {
        repository_id: string;
        pr_number: number;
        head_sha: string;
        reason: SyncRunTargetInput["reason"];
      };
      return {
        repositoryId: value.repository_id,
        number: value.pr_number,
        headSha: value.head_sha,
        reason: value.reason,
      };
    });
}

/** Accumulate bounded stream counters without storing provider pages. */
export function recordSyncRunPage(
  database: DatabaseClient,
  runId: string,
  update: SyncRunPageUpdate,
): void {
  const result = database
    .prepare(
      `UPDATE repository_sync_run_streams SET
         pages_fetched = pages_fetched + ?,
         items_seen = items_seen + ?,
         items_written = items_written + ?,
         rate_limit_remaining = COALESCE(?, rate_limit_remaining)
       WHERE run_id = ? AND entity_kind = ?`,
    )
    .run(
      update.pagesFetched ?? 1,
      update.itemsSeen ?? 0,
      update.itemsWritten ?? 0,
      update.rateLimitRemaining ?? null,
      runId,
      update.entityKind,
    );
  if (result.changes !== 1) {
    throw new Error(`Sync run stream not found: ${runId}/${update.entityKind}`);
  }
  database
    .prepare(
      `UPDATE repository_sync_runs SET
         items_seen = items_seen + ?, items_written = items_written + ?
       WHERE id = ?`,
    )
    .run(update.itemsSeen ?? 0, update.itemsWritten ?? 0, runId);
}

/** Complete one persisted stream and retain its resulting forward watermark. */
export function completeSyncRunStream(
  database: DatabaseClient,
  runId: string,
  entityKind: EntityKind,
  input: {
    finishedAt?: Date | string;
    rateLimitRemaining?: number | null;
    watermarkAfter?: string | null;
    status?: "completed" | "partial";
  } = {},
): SyncRunRecord {
  const finishedAt = runTimestamp(input.finishedAt);
  const status = input.status ?? "completed";
  const result = database
    .prepare(
      `UPDATE repository_sync_run_streams SET
         status = ?, finished_at = ?,
         rate_limit_remaining = COALESCE(?, rate_limit_remaining),
         watermark_after = ?
       WHERE run_id = ? AND entity_kind = ? AND status IN ('running', 'queued')`,
    )
    .run(
      status,
      finishedAt,
      input.rateLimitRemaining ?? null,
      input.watermarkAfter ?? null,
      runId,
      entityKind,
    );
  if (result.changes !== 1) {
    throw new InvalidSyncTransitionError(runId, entityKind, "Cannot complete sync run stream");
  }
  return finalizeSyncRun(database, runId, finishedAt);
}

export function failSyncRunStream(
  database: DatabaseClient,
  runId: string,
  entityKind: EntityKind,
  error: unknown,
  finishedAt?: Date | string,
): SyncRunRecord {
  const at = runTimestamp(finishedAt);
  const message = normalizeRunError(error);
  const result = database
    .prepare(
      `UPDATE repository_sync_run_streams SET
         status = 'failed', finished_at = ?, error = ?
       WHERE run_id = ? AND entity_kind = ? AND status IN ('running', 'queued')`,
    )
    .run(at, message, runId, entityKind);
  if (result.changes !== 1) {
    throw new InvalidSyncTransitionError(runId, entityKind, "Cannot fail sync run stream");
  }
  return finalizeSyncRun(database, runId, at, message);
}

function finalizeSyncRun(
  database: DatabaseClient,
  runId: string,
  finishedAt: string,
  streamError?: string,
): SyncRunRecord {
  const streams = database
    .prepare("SELECT status, error FROM repository_sync_run_streams WHERE run_id = ?")
    .all(runId) as Array<{ status: SyncRunStatus; error: string | null }>;
  const hasPending = streams.some((stream) =>
    stream.status === "queued" || stream.status === "running",
  );
  if (hasPending) return readSyncRun(database, runId)!;
  const failed = streams.filter((stream) =>
    stream.status === "failed" || stream.status === "interrupted",
  );
  const partial = streams.some((stream) => stream.status === "partial");
  const status: SyncRunStatus =
    failed.length === 0
      ? partial ? "partial" : "completed"
      : failed.length === streams.length
        ? "failed"
        : "partial";
  const error =
    streamError ??
    (failed.map((stream) => stream.error).filter(Boolean).join("; ") || null);
  database
    .prepare(
      `UPDATE repository_sync_runs SET status = ?, finished_at = ?, error = ?
       WHERE id = ? AND status IN ('queued', 'running')`,
    )
    .run(status, finishedAt, error, runId);
  return readSyncRun(database, runId)!;
}

export function getSyncRun(database: DatabaseClient, runId: string): SyncRunRecord {
  const run = readSyncRun(database, runId);
  if (run === null) throw new SyncRunNotFoundError(runId);
  return run;
}

export function listSyncRuns(
  database: DatabaseClient,
  repositoryId: string,
  limit = 20,
): SyncRunRecord[] {
  requireRepository(database, repositoryId);
  if (!Number.isInteger(limit) || limit <= 0 || limit > 100) {
    throw new Error("Sync run limit must be between 1 and 100");
  }
  const runs = database
    .prepare(
      `SELECT * FROM repository_sync_runs
       WHERE repository_id = ? ORDER BY COALESCE(started_at, requested_at) DESC LIMIT ?`,
    )
    .all(repositoryId, limit) as Array<{ id: string }>;
  if (runs.length === 0) return [];
  const placeholders = runs.map(() => "?").join(", ");
  const streamRows = database
    .prepare(
      `SELECT * FROM repository_sync_run_streams
       WHERE run_id IN (${placeholders}) ORDER BY entity_kind ASC`,
    )
    .all(...runs.map((row) => row.id)) as Array<Record<string, unknown>>;
  const streamsByRun = new Map<string, SyncRunStreamRecord[]>();
  for (const row of streamRows) {
    const stream = mapSyncRunStream(row);
    const existing = streamsByRun.get(stream.runId);
    if (existing === undefined) streamsByRun.set(stream.runId, [stream]);
    else existing.push(stream);
  }
  return runs.map((row) => mapSyncRunRecord(
    row as Record<string, unknown>,
    streamsByRun.get(row.id) ?? [],
  ));
}

export function recoverInterruptedSyncRuns(
  database: DatabaseClient,
  recoveredAt?: Date | string,
  reason = "Sync interrupted before completion",
): number {
  const at = runTimestamp(recoveredAt);
  const rows = database
    .prepare(
      `SELECT id FROM repository_sync_runs WHERE status IN ('queued', 'running')`,
    )
    .all() as Array<{ id: string }>;
  if (rows.length === 0) return 0;
  database.transaction(() => {
    database
      .prepare(
        `UPDATE repository_sync_runs
         SET status = 'interrupted', finished_at = ?, error = ?
         WHERE status IN ('queued', 'running')`,
      )
      .run(at, reason);
    database
      .prepare(
        `UPDATE repository_sync_run_streams
         SET status = 'interrupted', finished_at = ?, error = ?
         WHERE status IN ('queued', 'running')`,
      )
      .run(at, reason);
    database
      .prepare(
        `UPDATE repository_history_state
         SET status = 'failed', last_error = ?, updated_at = ?
         WHERE status = 'running'`,
      )
      .run(reason, at);
  })();
  return rows.length;
}

function ensureHistoryRows(database: DatabaseClient, repositoryId: string): void {
  const now = new Date().toISOString();
  database
    .prepare(
      `INSERT INTO repository_history_state
         (repository_id, entity_kind, updated_at)
       VALUES (?, 'pull_request', ?), (?, 'issue', ?)
       ON CONFLICT(repository_id, entity_kind) DO NOTHING`,
    )
    .run(repositoryId, now, repositoryId, now);
}

function mapHistoryState(row: Record<string, unknown>): RepositoryHistoryState {
  return {
    repositoryId: row.repository_id as string,
    entityKind: row.entity_kind as EntityKind,
    enabled: row.enabled === 1,
    status: row.status as RepositoryHistoryState["status"],
    targetDate: (row.target_date as string | null) ?? null,
    oldestCoveredDay: (row.oldest_covered_day as string | null) ?? null,
    cursor: (row.cursor as string | null) ?? null,
    recoveryAnchorUpdatedAt: (row.recovery_anchor_updated_at as string | null) ?? null,
    lastRunId: (row.last_run_id as string | null) ?? null,
    lastError: (row.last_error as string | null) ?? null,
    resumeAfter: (row.resume_after as string | null) ?? null,
    updatedAt: row.updated_at as string,
  };
}

export function getRepositoryHistoryState(
  database: DatabaseClient,
  repositoryId: string,
  entityKind: EntityKind,
): RepositoryHistoryState {
  requireRepository(database, repositoryId);
  ensureHistoryRows(database, repositoryId);
  const row = database
    .prepare(
      `SELECT * FROM repository_history_state
       WHERE repository_id = ? AND entity_kind = ?`,
    )
    .get(repositoryId, entityKind) as Record<string, unknown>;
  return mapHistoryState(row);
}

export interface UpdateHistoryStateInput {
  enabled?: boolean;
  status?: RepositoryHistoryState["status"];
  targetDate?: string | null;
  oldestCoveredDay?: string | null;
  cursor?: string | null;
  recoveryAnchorUpdatedAt?: string | null;
  lastRunId?: string | null;
  lastError?: string | null;
  resumeAfter?: Date | string | null;
  updatedAt?: Date | string;
}

export function updateRepositoryHistoryState(
  database: DatabaseClient,
  repositoryId: string,
  entityKind: EntityKind,
  input: UpdateHistoryStateInput,
): RepositoryHistoryState {
  const current = getRepositoryHistoryState(database, repositoryId, entityKind);
  database
    .prepare(
      `UPDATE repository_history_state SET
         enabled = ?, status = ?, target_date = ?, oldest_covered_day = ?,
         cursor = ?, recovery_anchor_updated_at = ?, last_run_id = ?,
         last_error = ?, resume_after = ?, updated_at = ?
       WHERE repository_id = ? AND entity_kind = ?`,
    )
    .run(
      input.enabled === undefined ? (current.enabled ? 1 : 0) : input.enabled ? 1 : 0,
      input.status ?? current.status,
      input.targetDate === undefined ? current.targetDate : input.targetDate,
      input.oldestCoveredDay === undefined ? current.oldestCoveredDay : input.oldestCoveredDay,
      input.cursor === undefined ? current.cursor : input.cursor,
      input.recoveryAnchorUpdatedAt === undefined
        ? current.recoveryAnchorUpdatedAt
        : input.recoveryAnchorUpdatedAt,
      input.lastRunId === undefined ? current.lastRunId : input.lastRunId,
      input.lastError === undefined ? current.lastError : input.lastError,
      input.resumeAfter === undefined || input.resumeAfter === null
        ? input.resumeAfter === null ? null : current.resumeAfter
        : runTimestamp(input.resumeAfter),
      runTimestamp(input.updatedAt),
      repositoryId,
      entityKind,
    );
  return getRepositoryHistoryState(database, repositoryId, entityKind);
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
