import { getMaintenanceRun } from "./retention-service.js";
import { requireRepository } from "./repository-service.js";
import {
  type DatabaseClient,
  type PurgeRuntimeHistoryBatchResult,
  type PurgeRuntimeHistoryInput,
  type PurgeRuntimeHistoryPreview,
  type PurgeRuntimeHistoryScope,
} from "./types.js";

const DEFAULT_RETENTION_DAYS = 30;
const DEFAULT_KEEP_LATEST = 100;
const DEFAULT_PURGE_BATCH_SIZE = 250;
const MAX_PURGE_BATCH_SIZE = 500;
const DAY_MS = 24 * 60 * 60 * 1000;

type RuntimeHistoryRow = {
  id: string;
};

interface NormalizedPurgeInput {
  scope: PurgeRuntimeHistoryScope;
  batchSize: number;
  maintenanceRunId: string | null;
}

function normalizeUtcTimestamp(value: string, field: string): string {
  if (typeof value !== "string" || !value.endsWith("Z")) {
    throw new Error(`${field} must be a UTC timestamp ending in Z`);
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error(`Invalid ${field}: ${value}`);
  return new Date(parsed).toISOString();
}

function nonNegativeInteger(value: number | undefined, fallback: number, field: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 0) {
    throw new Error(`${field} must be a non-negative safe integer`);
  }
  return resolved;
}

function purgeBatchSize(value: number | undefined): number {
  const resolved = value ?? DEFAULT_PURGE_BATCH_SIZE;
  if (!Number.isSafeInteger(resolved) || resolved <= 0 || resolved > MAX_PURGE_BATCH_SIZE) {
    throw new Error(`Purge batch size must be an integer between 1 and ${MAX_PURGE_BATCH_SIZE}`);
  }
  return resolved;
}

function deriveCutoff(asOf: string, retentionDays: number): string {
  const asOfMillis = Date.parse(asOf);
  const cutoffMillis = asOfMillis - retentionDays * DAY_MS;
  if (!Number.isFinite(cutoffMillis)) {
    throw new Error("Retention window produces an invalid cutoff");
  }
  const cutoff = new Date(cutoffMillis);
  if (!Number.isFinite(cutoff.getTime())) {
    throw new Error("Retention window produces an invalid cutoff");
  }
  return cutoff.toISOString();
}

function normalizePurgeInput(input: PurgeRuntimeHistoryInput): NormalizedPurgeInput {
  if (typeof input.repositoryId !== "string" || input.repositoryId.length === 0) {
    throw new Error("repositoryId must not be empty");
  }
  const retentionDays = nonNegativeInteger(
    input.retentionDays,
    DEFAULT_RETENTION_DAYS,
    "retentionDays",
  );
  const asOf = normalizeUtcTimestamp(
    input.asOf ?? new Date().toISOString(),
    "asOf",
  );
  const cutoff = input.cutoff === undefined
    ? deriveCutoff(asOf, retentionDays)
    : normalizeUtcTimestamp(input.cutoff, "cutoff");
  // The safety floor is never configurable below 100. A larger value is
  // useful for a repository that wants to retain more runtime history.
  const keepLatest = Math.max(
    DEFAULT_KEEP_LATEST,
    nonNegativeInteger(input.keepLatest, DEFAULT_KEEP_LATEST, "keepLatest"),
  );
  return {
    scope: {
      repositoryId: input.repositoryId,
      cutoff,
      retentionDays,
      keepLatest,
    },
    batchSize: purgeBatchSize(input.batchSize),
    maintenanceRunId: input.maintenanceRunId ?? null,
  };
}

function baseOldRunPredicate(alias: string): string {
  return `${alias}.repository_id = @repositoryId AND ${alias}.requested_at < @cutoff`;
}

function latestRankPredicate(alias: string): string {
  return `(
    SELECT COUNT(*)
    FROM repository_sync_runs newer
    WHERE newer.repository_id = ${alias}.repository_id
      AND (
        newer.requested_at > ${alias}.requested_at
        OR (
          newer.requested_at = ${alias}.requested_at
          AND newer.id >= ${alias}.id
        )
      )
  ) > @keepLatest`;
}

/**
 * repository_sync_state currently has no last_run_id column in the real
 * schema. Keep the protection predicate extensible so a later schema can
 * supply one without weakening this purge operation.
 */
function syncStateProtectionPredicate(database: DatabaseClient, alias: string): string {
  const columns = database
    .prepare("PRAGMA table_info(repository_sync_state)")
    .all() as Array<{ name: string }>;
  const runIdColumn = ["last_run_id", "last_sync_run_id"].find((name) =>
    columns.some((column) => column.name === name),
  );
  if (runIdColumn === undefined) return "1";
  return `NOT EXISTS (
    SELECT 1 FROM repository_sync_state current_sync
    WHERE current_sync.repository_id = ${alias}.repository_id
      AND current_sync.${runIdColumn} = ${alias}.id
  )`;
}

function protectedByHistoryStatePredicate(alias: string): string {
  return `NOT EXISTS (
    SELECT 1 FROM repository_history_state history_state
    WHERE history_state.repository_id = ${alias}.repository_id
      AND history_state.last_run_id = ${alias}.id
  )`;
}

function eligibleRunPredicate(database: DatabaseClient, alias: string): string {
  return `(
    ${baseOldRunPredicate(alias)}
    AND ${alias}.status NOT IN ('queued', 'running')
    AND ${latestRankPredicate(alias)}
    AND ${syncStateProtectionPredicate(database, alias)}
    AND ${protectedByHistoryStatePredicate(alias)}
  )`;
}

function parameters(scope: PurgeRuntimeHistoryScope): {
  repositoryId: string;
  cutoff: string;
  keepLatest: number;
} {
  return {
    repositoryId: scope.repositoryId,
    cutoff: scope.cutoff,
    keepLatest: scope.keepLatest,
  };
}

function scalarCount(database: DatabaseClient, statement: string, input: object): number {
  const row = database.prepare(statement).get(input) as { count: number };
  return Number(row.count);
}

function scopeParams(scope: PurgeRuntimeHistoryScope): object {
  return parameters(scope);
}

/** Preview removable runtime sync history without mutating any table. */
export function previewRuntimeHistoryPurge(
  database: DatabaseClient,
  input: PurgeRuntimeHistoryInput,
): PurgeRuntimeHistoryPreview {
  const normalized = normalizePurgeInput(input);
  const { scope } = normalized;
  requireRepository(database, scope.repositoryId);
  const eligible = eligibleRunPredicate(database, "run");
  const oldRuns = `${baseOldRunPredicate("run")}`;
  const queuedOrRunning = `run.status IN ('queued', 'running')`;
  const runCount = scalarCount(
    database,
    `SELECT COUNT(*) AS count FROM repository_sync_runs run WHERE ${eligible}`,
    scopeParams(scope),
  );
  const oldRunCount = scalarCount(
    database,
    `SELECT COUNT(*) AS count FROM repository_sync_runs run WHERE ${oldRuns}`,
    scopeParams(scope),
  );
  const queuedOrRunningCount = scalarCount(
    database,
    `SELECT COUNT(*) AS count FROM repository_sync_runs run
     WHERE ${oldRuns} AND ${queuedOrRunning}`,
    scopeParams(scope),
  );
  const streamCount = scalarCount(
    database,
    `SELECT COUNT(*) AS count
     FROM repository_sync_run_streams stream
     JOIN repository_sync_runs run ON run.id = stream.run_id
     WHERE ${eligible}`,
    scopeParams(scope),
  );
  const targetCount = scalarCount(
    database,
    `SELECT COUNT(*) AS count
     FROM repository_sync_run_targets target
     JOIN repository_sync_runs run ON run.id = target.run_id
     WHERE ${eligible}`,
    scopeParams(scope),
  );
  return {
    ...scope,
    runCount,
    protectedRunCount: Math.max(0, oldRunCount - runCount),
    queuedOrRunningCount,
    streamCount,
    targetCount,
  };
}

function parseSelector(value: string | null): Record<string, unknown> {
  if (value === null) return {};
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function updateMaintenanceRunCount(
  database: DatabaseClient,
  maintenanceRunId: string,
  repositoryId: string,
  runsDeleted: number,
): void {
  const run = getMaintenanceRun(database, maintenanceRunId);
  if (run === null) throw new Error(`Maintenance run not found: ${maintenanceRunId}`);
  if (run.repositoryId !== repositoryId) {
    throw new Error(`Maintenance run belongs to another repository: ${maintenanceRunId}`);
  }
  if (run.kind !== "purge_runtime_history") {
    throw new Error(`Maintenance run is not a runtime-history purge: ${maintenanceRunId}`);
  }
  if (run.status !== "queued" && run.status !== "running") {
    throw new Error(`Maintenance run is not active: ${maintenanceRunId}`);
  }
  const selector = parseSelector(
    database
      .prepare("SELECT selector_json FROM repository_maintenance_runs WHERE id = ?")
      .pluck()
      .get(maintenanceRunId) as string | null,
  );
  const previous = typeof selector.runsDeleted === "number" && Number.isSafeInteger(selector.runsDeleted)
    ? selector.runsDeleted
    : 0;
  selector.runsDeleted = previous + runsDeleted;
  database
    .prepare(
      `UPDATE repository_maintenance_runs
       SET selector_json = ?
       WHERE id = ? AND repository_id = ? AND kind = 'purge_runtime_history'
         AND status IN ('queued', 'running')`,
    )
    .run(JSON.stringify(selector), maintenanceRunId, repositoryId);
}

/** Delete one bounded set of eligible parent runs; FK cascade removes children. */
export function purgeRuntimeHistoryBatch(
  database: DatabaseClient,
  input: PurgeRuntimeHistoryInput,
): PurgeRuntimeHistoryBatchResult {
  const normalized = normalizePurgeInput(input);
  const { scope } = normalized;
  requireRepository(database, scope.repositoryId);
  if (normalized.maintenanceRunId !== null) {
    const run = getMaintenanceRun(database, normalized.maintenanceRunId);
    if (run === null) throw new Error(`Maintenance run not found: ${normalized.maintenanceRunId}`);
    if (run.repositoryId !== scope.repositoryId || run.kind !== "purge_runtime_history") {
      throw new Error(`Maintenance run is not a runtime-history purge: ${normalized.maintenanceRunId}`);
    }
    if (run.status !== "queued" && run.status !== "running") {
      throw new Error(`Maintenance run is not active: ${normalized.maintenanceRunId}`);
    }
  }

  let runsDeleted = 0;
  let streamsDeleted = 0;
  let targetsDeleted = 0;
  database.transaction(() => {
    const eligible = eligibleRunPredicate(database, "run");
    const candidates = database
      .prepare(`
        SELECT run.id
        FROM repository_sync_runs run
        WHERE ${eligible}
        ORDER BY run.requested_at ASC, run.id ASC
        LIMIT @batchSize
      `)
      .all({ ...scopeParams(scope), batchSize: normalized.batchSize }) as RuntimeHistoryRow[];
    const childCounts = database.prepare(`
      SELECT
        (SELECT COUNT(*) FROM repository_sync_run_streams WHERE run_id = @runId) AS streams,
        (SELECT COUNT(*) FROM repository_sync_run_targets WHERE run_id = @runId) AS targets
    `);
    const remove = database.prepare(`
      DELETE FROM repository_sync_runs
      WHERE id = @runId
        AND ${eligibleRunPredicate(database, "repository_sync_runs")}
    `);
    for (const candidate of candidates) {
      const children = childCounts.get({ runId: candidate.id }) as {
        streams: number;
        targets: number;
      };
      const deleted = remove.run({
        ...scopeParams(scope),
        runId: candidate.id,
      }).changes;
      if (deleted !== 1) continue;
      runsDeleted += 1;
      streamsDeleted += Number(children.streams);
      targetsDeleted += Number(children.targets);
    }
    if (normalized.maintenanceRunId !== null) {
      updateMaintenanceRunCount(
        database,
        normalized.maintenanceRunId,
        scope.repositoryId,
        runsDeleted,
      );
    }
  })();

  const eligible = eligibleRunPredicate(database, "run");
  const remaining = scalarCount(
    database,
    `SELECT COUNT(*) AS count FROM repository_sync_runs run WHERE ${eligible}`,
    scopeParams(scope),
  );
  return {
    ...scope,
    batchSize: normalized.batchSize,
    runsDeleted,
    streamsDeleted,
    targetsDeleted,
    hasMore: remaining > 0,
    maintenanceRunId: normalized.maintenanceRunId,
  };
}

// Names used by callers that describe this operation as sync-run retention.
export const previewSyncRunPurge = previewRuntimeHistoryPurge;
export const purgeSyncRunBatch = purgeRuntimeHistoryBatch;
