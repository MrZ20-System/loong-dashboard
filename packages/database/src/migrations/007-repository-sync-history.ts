import type Database from "better-sqlite3";

import type { Migration } from "../migration-runner.js";

/**
 * Durable repository synchronization runs, history continuation state, and
 * daily PR snapshots.  This is additive by design; migrations already applied
 * to a user's local database are never edited in place.
 */
export const repositorySyncHistoryMigration: Migration = {
  id: "007_repository_sync_history",
  migrate(database: Database.Database): void {
    database.exec(`
      CREATE TABLE repository_sync_runs (
        id TEXT PRIMARY KEY,
        repository_id TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('forward', 'history', 'fetch_pr')),
        trigger TEXT NOT NULL CHECK (trigger IN ('automatic', 'manual', 'api', 'system')),
        status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'partial', 'failed', 'interrupted')),
        requested_at TEXT NOT NULL,
        started_at TEXT,
        finished_at TEXT,
        selector_json TEXT NOT NULL DEFAULT '{}',
        items_seen INTEGER NOT NULL DEFAULT 0 CHECK (items_seen >= 0),
        items_written INTEGER NOT NULL DEFAULT 0 CHECK (items_written >= 0),
        error TEXT,
        FOREIGN KEY (repository_id) REFERENCES repositories(id) ON DELETE CASCADE
      );

      CREATE INDEX repository_sync_runs_repository_started_idx
        ON repository_sync_runs(repository_id, started_at DESC);
      CREATE INDEX repository_sync_runs_repository_kind_status_idx
        ON repository_sync_runs(repository_id, kind, status);

      CREATE TABLE repository_sync_run_streams (
        run_id TEXT NOT NULL,
        entity_kind TEXT NOT NULL CHECK (entity_kind IN ('pull_request', 'issue')),
        status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'partial', 'failed', 'interrupted')),
        pages_fetched INTEGER NOT NULL DEFAULT 0 CHECK (pages_fetched >= 0),
        items_seen INTEGER NOT NULL DEFAULT 0 CHECK (items_seen >= 0),
        items_written INTEGER NOT NULL DEFAULT 0 CHECK (items_written >= 0),
        watermark_before TEXT,
        watermark_after TEXT,
        rate_limit_remaining INTEGER CHECK (rate_limit_remaining IS NULL OR rate_limit_remaining >= 0),
        started_at TEXT,
        finished_at TEXT,
        error TEXT,
        PRIMARY KEY (run_id, entity_kind),
        FOREIGN KEY (run_id) REFERENCES repository_sync_runs(id) ON DELETE CASCADE
      );

      CREATE INDEX repository_sync_run_streams_status_idx
        ON repository_sync_run_streams(status, finished_at);

      CREATE TABLE repository_sync_run_targets (
        run_id TEXT NOT NULL,
        repository_id TEXT NOT NULL,
        pr_number INTEGER NOT NULL CHECK (pr_number > 0),
        head_sha TEXT NOT NULL,
        reason TEXT NOT NULL CHECK (reason IN ('new', 'head_changed', 'retry', 'history', 'fetch_pr')),
        PRIMARY KEY (run_id, repository_id, pr_number),
        FOREIGN KEY (run_id) REFERENCES repository_sync_runs(id) ON DELETE CASCADE,
        FOREIGN KEY (repository_id) REFERENCES repositories(id) ON DELETE CASCADE
      );

      CREATE INDEX repository_sync_run_targets_repository_idx
        ON repository_sync_run_targets(repository_id, pr_number);

      CREATE TABLE repository_history_state (
        repository_id TEXT NOT NULL,
        entity_kind TEXT NOT NULL CHECK (entity_kind IN ('pull_request', 'issue')),
        enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
        status TEXT NOT NULL DEFAULT 'idle' CHECK (status IN ('idle', 'running', 'paused', 'failed', 'completed')),
        target_date TEXT,
        oldest_covered_day TEXT,
        cursor TEXT,
        recovery_anchor_updated_at TEXT,
        last_run_id TEXT,
        last_error TEXT,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (repository_id, entity_kind),
        FOREIGN KEY (repository_id) REFERENCES repositories(id) ON DELETE CASCADE,
        FOREIGN KEY (last_run_id) REFERENCES repository_sync_runs(id) ON DELETE SET NULL
      );

      CREATE INDEX repository_history_state_target_idx
        ON repository_history_state(repository_id, entity_kind, oldest_covered_day);

      CREATE TABLE repository_history_coverage (
        repository_id TEXT NOT NULL,
        entity_kind TEXT NOT NULL CHECK (entity_kind IN ('pull_request', 'issue')),
        day TEXT NOT NULL,
        covered_at TEXT NOT NULL,
        items_seen INTEGER NOT NULL DEFAULT 0 CHECK (items_seen >= 0),
        complete INTEGER NOT NULL DEFAULT 0 CHECK (complete IN (0, 1)),
        PRIMARY KEY (repository_id, entity_kind, day),
        FOREIGN KEY (repository_id) REFERENCES repositories(id) ON DELETE CASCADE
      );

      CREATE INDEX repository_history_coverage_day_idx
        ON repository_history_coverage(repository_id, day);

      CREATE TABLE pull_request_daily_snapshots (
        repository_id TEXT NOT NULL,
        pr_number INTEGER NOT NULL CHECK (pr_number > 0),
        day TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('draft', 'open', 'closed', 'merged')),
        is_draft INTEGER NOT NULL CHECK (is_draft IN (0, 1)),
        title TEXT NOT NULL,
        head_sha TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        closed_at TEXT,
        merged_at TEXT,
        last_observed_at TEXT NOT NULL,
        source_run_id TEXT,
        PRIMARY KEY (repository_id, pr_number, day),
        FOREIGN KEY (repository_id) REFERENCES repositories(id) ON DELETE CASCADE,
        FOREIGN KEY (source_run_id) REFERENCES repository_sync_runs(id) ON DELETE SET NULL
      );

      CREATE INDEX pull_request_daily_snapshots_repository_day_idx
        ON pull_request_daily_snapshots(repository_id, day);
      CREATE INDEX pull_request_daily_snapshots_repository_pr_day_idx
        ON pull_request_daily_snapshots(repository_id, pr_number, day);
    `);
  },
};
