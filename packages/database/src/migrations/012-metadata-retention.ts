import type Database from "better-sqlite3";

import type { Migration } from "../migration-runner.js";

/**
 * Store the reversible metadata-retention state without deleting the entity
 * rows themselves.  This migration deliberately does not touch the merged
 * projection index or any of the sync-run tables.
 */
export const metadataRetentionMigration: Migration = {
  id: "012_metadata_retention",
  migrate(database: Database.Database): void {
    const pullRequestColumns = database
      .prepare("PRAGMA table_info(pull_requests)")
      .all() as Array<{ name: string }>;
    if (!pullRequestColumns.some((column) => column.name === "archived_at")) {
      database.exec("ALTER TABLE pull_requests ADD COLUMN archived_at TEXT;");
    }
    if (!pullRequestColumns.some((column) => column.name === "payload_pruned_at")) {
      database.exec("ALTER TABLE pull_requests ADD COLUMN payload_pruned_at TEXT;");
    }

    const issueColumns = database
      .prepare("PRAGMA table_info(issues)")
      .all() as Array<{ name: string }>;
    if (!issueColumns.some((column) => column.name === "archived_at")) {
      database.exec("ALTER TABLE issues ADD COLUMN archived_at TEXT;");
    }
    if (!issueColumns.some((column) => column.name === "payload_pruned_at")) {
      database.exec("ALTER TABLE issues ADD COLUMN payload_pruned_at TEXT;");
    }

    database.exec(`
      CREATE TABLE IF NOT EXISTS repository_maintenance_runs (
        id TEXT PRIMARY KEY,
        repository_id TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (
          kind IN ('archive', 'prune', 'purge_runtime_history', 'optimize')
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

      CREATE INDEX IF NOT EXISTS pull_requests_retention_idx
        ON pull_requests(repository_id, archived_at, status, updated_at);
      CREATE INDEX IF NOT EXISTS issues_retention_idx
        ON issues(repository_id, archived_at, state, updated_at);
      CREATE INDEX IF NOT EXISTS repository_maintenance_runs_repository_requested_idx
        ON repository_maintenance_runs(repository_id, requested_at DESC);
    `);
  },
};
