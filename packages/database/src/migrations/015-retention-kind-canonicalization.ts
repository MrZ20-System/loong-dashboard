import type Database from "better-sqlite3";

import type { Migration } from "../migration-runner.js";

const LEGACY_OPTIMIZE_NOTE =
  "Legacy optimize maintenance runs had no canonical product operation; the row was retained as an interrupted archive run during migration.";

type LegacyMaintenanceRun = {
  id: string;
  repository_id: string;
  kind: string;
  trigger: string;
  status: string;
  cutoff: string | null;
  selector_json: string;
  requested_at: string;
  started_at: string | null;
  finished_at: string | null;
  pr_count: number;
  issue_count: number;
  files_deleted: number;
  comments_deleted: number;
  error: string | null;
};

function migratedOptimizeSelector(selectorJson: string): string {
  let selector: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(selectorJson);
    selector = parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : { legacySelectorJson: selectorJson };
  } catch {
    selector = { legacySelectorJson: selectorJson };
  }

  return JSON.stringify({
    ...selector,
    legacyMaintenanceMigration: {
      fromKind: "optimize",
      note: LEGACY_OPTIMIZE_NOTE,
    },
  });
}

function migratedOptimizeError(error: string | null): string {
  return error === null || error.length === 0
    ? LEGACY_OPTIMIZE_NOTE
    : `${error}\n${LEGACY_OPTIMIZE_NOTE}`;
}

function assertForeignKeys(database: Database.Database): void {
  const violations = database.pragma("foreign_key_check") as Array<
    Record<string, unknown>
  >;
  if (violations.length > 0) {
    throw new Error(
      `Retention kind canonicalization produced foreign-key violations: ${JSON.stringify(violations)}`,
    );
  }
}

/**
 * Replace the permissive maintenance kind constraint with the canonical
 * archive and runtime-history operations. Legacy rows remain queryable: prune
 * becomes archive, while optimize becomes an interrupted archive with an
 * explicit migration note because no product operation can safely reproduce
 * its old meaning.
 */
export const retentionKindCanonicalizationMigration: Migration = {
  id: "015_retention_kind_canonicalization",
  migrate(database: Database.Database): void {
    database.pragma("defer_foreign_keys = ON");

    database.exec(`
      CREATE TEMP TABLE retention_kind_source AS
        SELECT * FROM repository_maintenance_runs;
    `);
    const rows = database
      .prepare("SELECT * FROM retention_kind_source ORDER BY id")
      .all() as LegacyMaintenanceRun[];

    database.exec(`
      DROP TABLE repository_maintenance_runs;

      CREATE TABLE repository_maintenance_runs (
        id TEXT PRIMARY KEY,
        repository_id TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (
          kind IN ('archive', 'purge_runtime_history')
        ),
        trigger TEXT NOT NULL CHECK (trigger IN ('manual', 'automatic')),
        status TEXT NOT NULL CHECK (
          status IN ('queued', 'running', 'completed', 'failed', 'interrupted')
        ),
        cutoff TEXT,
        selector_json TEXT NOT NULL DEFAULT '{}',
        requested_at TEXT NOT NULL,
        started_at TEXT,
        finished_at TEXT,
        pr_count INTEGER NOT NULL DEFAULT 0 CHECK (pr_count >= 0),
        issue_count INTEGER NOT NULL DEFAULT 0 CHECK (issue_count >= 0),
        files_deleted INTEGER NOT NULL DEFAULT 0 CHECK (files_deleted >= 0),
        comments_deleted INTEGER NOT NULL DEFAULT 0 CHECK (comments_deleted >= 0),
        error TEXT,
        FOREIGN KEY (repository_id) REFERENCES repositories(id) ON DELETE CASCADE
      );
    `);

    const insert = database.prepare(`
      INSERT INTO repository_maintenance_runs (
        id, repository_id, kind, trigger, status, cutoff, selector_json,
        requested_at, started_at, finished_at, pr_count, issue_count,
        files_deleted, comments_deleted, error
      ) VALUES (
        @id, @repositoryId, @kind, @trigger, @status, @cutoff, @selectorJson,
        @requestedAt, @startedAt, @finishedAt, @prCount, @issueCount,
        @filesDeleted, @commentsDeleted, @error
      )
    `);

    for (const row of rows) {
      const isLegacyOptimize = row.kind === "optimize";
      insert.run({
        id: row.id,
        repositoryId: row.repository_id,
        kind: row.kind === "prune" || isLegacyOptimize ? "archive" : row.kind,
        trigger: row.trigger,
        status: isLegacyOptimize ? "interrupted" : row.status,
        cutoff: row.cutoff,
        selectorJson: isLegacyOptimize
          ? migratedOptimizeSelector(row.selector_json)
          : row.selector_json,
        requestedAt: row.requested_at,
        startedAt: row.started_at,
        finishedAt: row.finished_at,
        prCount: row.pr_count,
        issueCount: row.issue_count,
        filesDeleted: row.files_deleted,
        commentsDeleted: row.comments_deleted,
        error: isLegacyOptimize
          ? migratedOptimizeError(row.error)
          : row.error,
      });
    }

    database.exec(`
      DROP TABLE retention_kind_source;

      CREATE INDEX repository_maintenance_runs_repository_requested_idx
        ON repository_maintenance_runs(repository_id, requested_at DESC);
    `);
    assertForeignKeys(database);
  },
};
