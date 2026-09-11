import { randomUUID } from "node:crypto";

import type Database from "better-sqlite3";

import { requireRepository } from "./repository-service.js";
import {
  type ArchiveBatchInput,
  type ArchiveBatchResult,
  type ArchivePreview,
  type ArchivePreviewInput,
  type ArchiveScope,
  type CreateMaintenanceRunInput,
  type DatabaseClient,
  type MaintenanceRunKind,
  type MaintenanceRunRecord,
  type MaintenanceRunStatus,
  type MaintenanceRunTrigger,
  type RestoreResult,
  type UpdateMaintenanceRunInput,
} from "./types.js";

const DEFAULT_ARCHIVE_BATCH_SIZE = 250;
const MIN_ARCHIVE_BATCH_SIZE = 200;
const MAX_ARCHIVE_BATCH_SIZE = 500;

const MAINTENANCE_KINDS = [
  "archive",
  "purge_runtime_history",
] as const satisfies readonly MaintenanceRunKind[];
const MAINTENANCE_TRIGGERS = ["manual", "automatic"] as const satisfies readonly MaintenanceRunTrigger[];
const MAINTENANCE_STATUSES = [
  "queued",
  "running",
  "completed",
  "failed",
  "interrupted",
] as const satisfies readonly MaintenanceRunStatus[];

type MaintenanceRow = Record<string, unknown>;
type ArchiveCandidate = {
  entity_kind: "pull_request" | "issue";
  number: number;
};

export class MaintenanceRunNotFoundError extends Error {
  readonly code = "MAINTENANCE_RUN_NOT_FOUND" as const;

  constructor(runId: string) {
    super(`Maintenance run not found: ${runId}`);
    this.name = "MaintenanceRunNotFoundError";
  }
}

export class InvalidMaintenanceRunTransitionError extends Error {
  readonly code = "INVALID_MAINTENANCE_TRANSITION" as const;

  constructor(runId: string, from: MaintenanceRunStatus, to: MaintenanceRunStatus) {
    super(`Invalid maintenance run transition ${runId}: ${from} -> ${to}`);
    this.name = "InvalidMaintenanceRunTransitionError";
  }
}

function normalizeUtcTimestamp(value: string, field: string): string {
  if (typeof value !== "string" || !value.endsWith("Z")) {
    throw new Error(`${field} must be a UTC timestamp ending in Z`);
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error(`Invalid ${field}: ${value}`);
  return new Date(parsed).toISOString();
}

function normalizeOptionalUtcTimestamp(
  value: string | null | undefined,
  field: string,
): string | null {
  return value == null ? null : normalizeUtcTimestamp(value, field);
}

function normalizeArchiveInput(input: ArchivePreviewInput): ArchivePreviewInput {
  if (typeof input.repositoryId !== "string" || input.repositoryId.length === 0) {
    throw new Error("repositoryId must not be empty");
  }
  for (const [name, value] of [
    ["includeMergedPrs", input.includeMergedPrs],
    ["includeClosedPrs", input.includeClosedPrs],
    ["includeClosedIssues", input.includeClosedIssues],
  ] as const) {
    if (typeof value !== "boolean") throw new Error(`${name} must be a boolean`);
  }
  return {
    repositoryId: input.repositoryId,
    cutoff: normalizeUtcTimestamp(input.cutoff, "cutoff"),
    includeMergedPrs: input.includeMergedPrs,
    includeClosedPrs: input.includeClosedPrs,
    includeClosedIssues: input.includeClosedIssues,
  };
}

function archiveScopes(input: ArchivePreviewInput): ArchiveScope[] {
  const scopes: ArchiveScope[] = [];
  if (input.includeMergedPrs) scopes.push("merged_prs");
  if (input.includeClosedPrs) scopes.push("closed_prs");
  if (input.includeClosedIssues) scopes.push("closed_issues");
  return scopes;
}

function pullRequestArchivePredicate(input: ArchivePreviewInput, alias = ""): string {
  const prefix = alias.length > 0 ? `${alias}.` : "";
  const terminalStates: string[] = [];
  if (input.includeMergedPrs) terminalStates.push(`${prefix}status = 'merged' AND ${prefix}is_draft = 0`);
  if (input.includeClosedPrs) terminalStates.push(`${prefix}status = 'closed' AND ${prefix}is_draft = 0`);
  if (terminalStates.length === 0) return "0";
  return `(
    ${prefix}archived_at IS NULL
    AND ${prefix}updated_at < @cutoff
    AND (${terminalStates.join(" OR ")})
  )`;
}

function issueArchivePredicate(input: ArchivePreviewInput, alias = ""): string {
  const prefix = alias.length > 0 ? `${alias}.` : "";
  if (!input.includeClosedIssues) return "0";
  return `(
    ${prefix}archived_at IS NULL
    AND ${prefix}updated_at < @cutoff
    AND ${prefix}state = 'closed'
  )`;
}

function count(database: DatabaseClient, statement: string, parameters: object): number {
  const row = database.prepare(statement).get(parameters) as { count: number };
  return Number(row.count);
}

/** Preview exactly the selected terminal scopes. This function never writes. */
export function previewArchive(
  database: DatabaseClient,
  input: ArchivePreviewInput,
): ArchivePreview {
  const normalized = normalizeArchiveInput(input);
  requireRepository(database, normalized.repositoryId);
  const parameters = {
    repositoryId: normalized.repositoryId,
    cutoff: normalized.cutoff,
  };
  const prWhere = `p.repository_id = @repositoryId AND ${pullRequestArchivePredicate(normalized, "p")}`;
  const issueWhere = `i.repository_id = @repositoryId AND ${issueArchivePredicate(normalized, "i")}`;
  const mergedPrCount = normalized.includeMergedPrs
    ? count(
        database,
        `SELECT COUNT(*) AS count FROM pull_requests p
         WHERE p.repository_id = @repositoryId AND p.archived_at IS NULL
           AND p.updated_at < @cutoff AND p.status = 'merged' AND p.is_draft = 0`,
        parameters,
      )
    : 0;
  const closedPrCount = normalized.includeClosedPrs
    ? count(
        database,
        `SELECT COUNT(*) AS count FROM pull_requests p
         WHERE p.repository_id = @repositoryId AND p.archived_at IS NULL
           AND p.updated_at < @cutoff AND p.status = 'closed' AND p.is_draft = 0`,
        parameters,
      )
    : 0;
  const closedIssueCount = normalized.includeClosedIssues
    ? count(
        database,
        `SELECT COUNT(*) AS count FROM issues i
         WHERE i.repository_id = @repositoryId AND i.archived_at IS NULL
           AND i.updated_at < @cutoff AND i.state = 'closed'`,
        parameters,
      )
    : 0;
  const prFileRows = count(
    database,
    `SELECT COUNT(*) AS count
     FROM pull_request_files f
     JOIN pull_requests p
       ON p.repository_id = f.repository_id AND p.number = f.pr_number
     WHERE ${prWhere}`,
    parameters,
  );
  const issueCommentRows = count(
    database,
    `SELECT COUNT(*) AS count
     FROM issue_comments c
     JOIN issues i
       ON i.repository_id = c.repository_id AND i.number = c.issue_number
     WHERE ${issueWhere}`,
    parameters,
  );
  const prPayloadCount = count(
    database,
    `SELECT COUNT(*) AS count FROM pull_requests p
     WHERE ${prWhere}
       AND (p.detail_body IS NOT NULL OR EXISTS (
         SELECT 1 FROM pull_request_files f
         WHERE f.repository_id = p.repository_id AND f.pr_number = p.number
       ))`,
    parameters,
  );
  const issuePayloadCount = count(
    database,
    `SELECT COUNT(*) AS count FROM issues i
     WHERE ${issueWhere}
       AND (i.detail_body IS NOT NULL
         OR i.detail_synced_updated_at IS NOT NULL
         OR EXISTS (
           SELECT 1 FROM issue_comments c
           WHERE c.repository_id = i.repository_id AND c.issue_number = i.number
         ))`,
    parameters,
  );
  return {
    ...normalized,
    scopes: archiveScopes(normalized),
    mergedPrCount,
    closedPrCount,
    closedIssueCount,
    prFileRows,
    issueCommentRows,
    prPayloadCount,
    issuePayloadCount,
  };
}

function validateBatchSize(value: number | undefined): number {
  const batchSize = value ?? DEFAULT_ARCHIVE_BATCH_SIZE;
  if (
    !Number.isInteger(batchSize) ||
    batchSize < MIN_ARCHIVE_BATCH_SIZE ||
    batchSize > MAX_ARCHIVE_BATCH_SIZE
  ) {
    throw new Error(
      `Archive batch size must be an integer between ${MIN_ARCHIVE_BATCH_SIZE} and ${MAX_ARCHIVE_BATCH_SIZE}`,
    );
  }
  return batchSize;
}

function candidateQuery(input: ArchivePreviewInput): string {
  return `
    SELECT entity_kind, number FROM (
      SELECT 'pull_request' AS entity_kind, p.number AS number, p.updated_at AS updated_at
      FROM pull_requests p
      WHERE p.repository_id = @repositoryId
        AND ${pullRequestArchivePredicate(input, "p")}
      UNION ALL
      SELECT 'issue' AS entity_kind, i.number AS number, i.updated_at AS updated_at
      FROM issues i
      WHERE i.repository_id = @repositoryId
        AND ${issueArchivePredicate(input, "i")}
    ) candidates
    ORDER BY updated_at ASC, entity_kind ASC, number ASC
    LIMIT @batchSize
  `;
}

/** Archive and optionally prune one bounded batch in one transaction. */
export function archiveBatch(
  database: DatabaseClient,
  input: ArchiveBatchInput,
): ArchiveBatchResult {
  const normalized = normalizeArchiveInput(input);
  const archiveAt = normalizeUtcTimestamp(input.archiveAt, "archiveAt");
  const batchSize = validateBatchSize(input.batchSize);
  requireRepository(database, normalized.repositoryId);

  const result: Omit<ArchiveBatchResult, "hasMore"> = {
    repositoryId: normalized.repositoryId,
    cutoff: normalized.cutoff,
    archiveAt,
    batchSize,
    prCount: 0,
    issueCount: 0,
    filesDeleted: 0,
    commentsDeleted: 0,
    prPayloadPruned: 0,
    issuePayloadPruned: 0,
  };

  database.transaction(() => {
    const candidates = database
      .prepare(candidateQuery(normalized))
      .all({
        repositoryId: normalized.repositoryId,
        cutoff: normalized.cutoff,
        batchSize,
      }) as ArchiveCandidate[];
    const updatePr = database.prepare(`
      UPDATE pull_requests
      SET archived_at = @archiveAt${input.prune ? ", detail_body = NULL, files_truncated = 0, payload_pruned_at = @archiveAt" : ""}
      WHERE repository_id = @repositoryId AND number = @number
        AND ${pullRequestArchivePredicate(normalized)}
    `);
    const updateIssue = database.prepare(`
      UPDATE issues
      SET archived_at = @archiveAt${input.prune ? ", detail_body = NULL, detail_synced_updated_at = NULL, payload_pruned_at = @archiveAt" : ""}
      WHERE repository_id = @repositoryId AND number = @number
        AND ${issueArchivePredicate(normalized)}
    `);
    const deleteFiles = database.prepare(
      "DELETE FROM pull_request_files WHERE repository_id = @repositoryId AND pr_number = @number",
    );
    const deleteComments = database.prepare(
      "DELETE FROM issue_comments WHERE repository_id = @repositoryId AND issue_number = @number",
    );

    for (const candidate of candidates) {
      const parameters = {
        repositoryId: normalized.repositoryId,
        number: candidate.number,
        cutoff: normalized.cutoff,
        archiveAt,
      };
      if (candidate.entity_kind === "pull_request") {
        const updated = updatePr.run(parameters).changes;
        if (updated !== 1) continue;
        result.prCount += 1;
        if (input.prune) {
          result.filesDeleted += deleteFiles.run(parameters).changes;
          result.prPayloadPruned += 1;
        }
      } else {
        const updated = updateIssue.run(parameters).changes;
        if (updated !== 1) continue;
        result.issueCount += 1;
        if (input.prune) {
          result.commentsDeleted += deleteComments.run(parameters).changes;
          result.issuePayloadPruned += 1;
        }
      }
    }
  })();

  const hasMore = database
    .prepare(`
      SELECT EXISTS (
        SELECT 1 FROM pull_requests p
        WHERE p.repository_id = @repositoryId
          AND ${pullRequestArchivePredicate(normalized, "p")}
        UNION ALL
        SELECT 1 FROM issues i
        WHERE i.repository_id = @repositoryId
          AND ${issueArchivePredicate(normalized, "i")}
      ) AS has_more
    `)
    .get({ repositoryId: normalized.repositoryId, cutoff: normalized.cutoff }) as {
      has_more: number;
    };
  return { ...result, hasMore: hasMore.has_more === 1 };
}

function normalizeSelector(value: Record<string, unknown> | undefined): string {
  if (value === undefined) return "{}";
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error("Maintenance selector must be JSON serializable");
  return encoded;
}

function parseSelector(value: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function mapMaintenanceRun(row: MaintenanceRow): MaintenanceRunRecord {
  return {
    id: row.id as string,
    repositoryId: row.repository_id as string,
    kind: row.kind as MaintenanceRunKind,
    trigger: row.trigger as MaintenanceRunTrigger,
    status: row.status as MaintenanceRunStatus,
    cutoff: (row.cutoff as string | null) ?? null,
    selector: parseSelector(row.selector_json as string),
    requestedAt: row.requested_at as string,
    startedAt: (row.started_at as string | null) ?? null,
    finishedAt: (row.finished_at as string | null) ?? null,
    prCount: Number(row.pr_count ?? 0),
    issueCount: Number(row.issue_count ?? 0),
    filesDeleted: Number(row.files_deleted ?? 0),
    commentsDeleted: Number(row.comments_deleted ?? 0),
    error: (row.error as string | null) ?? null,
  };
}

function timestamp(value: string | null | undefined): string | null {
  return normalizeOptionalUtcTimestamp(value, "timestamp");
}

function assertMaintenanceKind(value: MaintenanceRunKind): void {
  if (!(MAINTENANCE_KINDS as readonly string[]).includes(value)) {
    throw new Error(`Unknown maintenance run kind: ${String(value)}`);
  }
}

function assertMaintenanceTrigger(value: MaintenanceRunTrigger): void {
  if (!(MAINTENANCE_TRIGGERS as readonly string[]).includes(value)) {
    throw new Error(`Unknown maintenance run trigger: ${String(value)}`);
  }
}

function assertMaintenanceStatus(value: MaintenanceRunStatus): void {
  if (!(MAINTENANCE_STATUSES as readonly string[]).includes(value)) {
    throw new Error(`Unknown maintenance run status: ${String(value)}`);
  }
}

/** Create a queued maintenance run with its selector persisted verbatim as JSON. */
export function createMaintenanceRun(
  database: DatabaseClient,
  input: CreateMaintenanceRunInput,
): MaintenanceRunRecord {
  requireRepository(database, input.repositoryId);
  assertMaintenanceKind(input.kind);
  assertMaintenanceTrigger(input.trigger);
  const id = input.id ?? randomUUID();
  const requestedAt = timestamp(input.requestedAt) ?? new Date().toISOString();
  const cutoff = normalizeOptionalUtcTimestamp(input.cutoff, "cutoff");
  database
    .prepare(`
      INSERT INTO repository_maintenance_runs
        (id, repository_id, kind, trigger, status, cutoff, selector_json, requested_at)
      VALUES (@id, @repositoryId, @kind, @trigger, 'queued', @cutoff, @selectorJson, @requestedAt)
    `)
    .run({
      id,
      repositoryId: input.repositoryId,
      kind: input.kind,
      trigger: input.trigger,
      cutoff,
      selectorJson: normalizeSelector(input.selector),
      requestedAt,
    });
  return getMaintenanceRun(database, id)!;
}

export function getMaintenanceRun(
  database: DatabaseClient,
  runId: string,
): MaintenanceRunRecord | null {
  const row = database
    .prepare("SELECT * FROM repository_maintenance_runs WHERE id = ?")
    .get(runId) as MaintenanceRow | undefined;
  return row === undefined ? null : mapMaintenanceRun(row);
}

export function requireMaintenanceRun(
  database: DatabaseClient,
  runId: string,
): MaintenanceRunRecord {
  const run = getMaintenanceRun(database, runId);
  if (run === null) throw new MaintenanceRunNotFoundError(runId);
  return run;
}

export function listMaintenanceRuns(
  database: DatabaseClient,
  repositoryId: string,
  limit = 50,
): MaintenanceRunRecord[] {
  requireRepository(database, repositoryId);
  if (!Number.isInteger(limit) || limit <= 0 || limit > 100) {
    throw new Error("Maintenance run limit must be an integer between 1 and 100");
  }
  return database
    .prepare(`
      SELECT * FROM repository_maintenance_runs
      WHERE repository_id = ?
      ORDER BY requested_at DESC, id DESC
      LIMIT ?
    `)
    .all(repositoryId, limit)
    .map((row) => mapMaintenanceRun(row as MaintenanceRow));
}

const ALLOWED_TRANSITIONS: Record<MaintenanceRunStatus, readonly MaintenanceRunStatus[]> = {
  queued: ["running", "failed", "interrupted"],
  running: ["completed", "failed", "interrupted"],
  completed: [],
  failed: [],
  interrupted: [],
};

function validateCounter(name: string, value: number | undefined): void {
  if (value !== undefined && (!Number.isInteger(value) || value < 0)) {
    throw new Error(`${name} must be a non-negative integer`);
  }
}

/** Update a run using an explicit, finite state machine. */
export function updateMaintenanceRun(
  database: DatabaseClient,
  runId: string,
  input: UpdateMaintenanceRunInput,
): MaintenanceRunRecord {
  let updated: MaintenanceRunRecord | null = null;
  database.transaction(() => {
    const existing = requireMaintenanceRun(database, runId);
    if (input.status !== undefined) {
      assertMaintenanceStatus(input.status);
      if (
        input.status !== existing.status &&
        !ALLOWED_TRANSITIONS[existing.status].includes(input.status)
      ) {
        throw new InvalidMaintenanceRunTransitionError(runId, existing.status, input.status);
      }
    }
    validateCounter("prCount", input.prCount);
    validateCounter("issueCount", input.issueCount);
    validateCounter("filesDeleted", input.filesDeleted);
    validateCounter("commentsDeleted", input.commentsDeleted);

    const sets: string[] = [];
    const parameters: Record<string, unknown> = { runId, expectedStatus: existing.status };
    if (input.status !== undefined) {
      sets.push("status = @status");
      parameters.status = input.status;
    }
    if ("startedAt" in input) {
      sets.push("started_at = @startedAt");
      parameters.startedAt = timestamp(input.startedAt);
    }
    if ("finishedAt" in input) {
      sets.push("finished_at = @finishedAt");
      parameters.finishedAt = timestamp(input.finishedAt);
    }
    if (input.prCount !== undefined) {
      sets.push("pr_count = @prCount");
      parameters.prCount = input.prCount;
    }
    if (input.issueCount !== undefined) {
      sets.push("issue_count = @issueCount");
      parameters.issueCount = input.issueCount;
    }
    if (input.filesDeleted !== undefined) {
      sets.push("files_deleted = @filesDeleted");
      parameters.filesDeleted = input.filesDeleted;
    }
    if (input.commentsDeleted !== undefined) {
      sets.push("comments_deleted = @commentsDeleted");
      parameters.commentsDeleted = input.commentsDeleted;
    }
    if ("error" in input) {
      sets.push("error = @error");
      parameters.error = input.error ?? null;
    }
    if (sets.length > 0) {
      database
        .prepare(`UPDATE repository_maintenance_runs SET ${sets.join(", ")} WHERE id = @runId AND status = @expectedStatus`)
        .run(parameters);
    }
    updated = requireMaintenanceRun(database, runId);
  })();
  return updated!;
}

function restoreEntity(
  database: DatabaseClient,
  repositoryId: string,
  number: number,
  table: "pull_requests" | "issues",
  entityKind: RestoreResult["entityKind"],
): RestoreResult {
  requireRepository(database, repositoryId);
  const row = database
    .prepare(`SELECT payload_pruned_at FROM ${table} WHERE repository_id = ? AND number = ?`)
    .get(repositoryId, number) as { payload_pruned_at: string | null } | undefined;
  if (row === undefined) {
    throw new Error(`Cannot restore missing ${entityKind} ${repositoryId}#${number}`);
  }
  database
    .prepare(`UPDATE ${table} SET archived_at = NULL WHERE repository_id = ? AND number = ?`)
    .run(repositoryId, number);
  return {
    repositoryId,
    entityKind,
    number,
    archivedAt: null,
    payloadPrunedAt: row.payload_pruned_at ?? null,
  };
}

export function restorePullRequest(
  database: DatabaseClient,
  repositoryId: string,
  number: number,
): RestoreResult {
  return restoreEntity(database, repositoryId, number, "pull_requests", "pull_request");
}

export function restoreIssue(
  database: DatabaseClient,
  repositoryId: string,
  number: number,
): RestoreResult {
  return restoreEntity(database, repositoryId, number, "issues", "issue");
}
