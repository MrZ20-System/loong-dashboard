import type Database from "better-sqlite3";

import type { Migration } from "../migration-runner.js";

/**
 * Persist the small set of GitHub lifecycle facts needed to replay PR EOD
 * state locally.  Timeline facts are keyed by the PR event id; they are
 * fetched once per history candidate, never once per calendar day.
 */
export const pullRequestLifecycleMigration: Migration = {
  id: "008_pull_request_lifecycle",
  migrate(database: Database.Database): void {
    database.exec(`
      DROP INDEX IF EXISTS pull_request_daily_snapshots_repository_day_idx;
      DROP INDEX IF EXISTS pull_request_daily_snapshots_repository_pr_day_idx;

      ALTER TABLE pull_request_daily_snapshots
        RENAME TO pull_request_daily_snapshots_legacy;

      CREATE TABLE pull_request_daily_snapshots (
        repository_id TEXT NOT NULL,
        pr_number INTEGER NOT NULL CHECK (pr_number > 0),
        day TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('draft', 'open', 'closed', 'merged')),
        is_draft INTEGER NOT NULL CHECK (is_draft IN (0, 1)),
        title TEXT,
        head_sha TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT,
        closed_at TEXT,
        merged_at TEXT,
        last_observed_at TEXT NOT NULL,
        source_run_id TEXT,
        PRIMARY KEY (repository_id, pr_number, day),
        FOREIGN KEY (repository_id) REFERENCES repositories(id) ON DELETE CASCADE,
        FOREIGN KEY (source_run_id) REFERENCES repository_sync_runs(id) ON DELETE SET NULL
      );

      INSERT INTO pull_request_daily_snapshots (
        repository_id, pr_number, day, status, is_draft, title, head_sha,
        created_at, updated_at, closed_at, merged_at, last_observed_at, source_run_id
      )
      SELECT repository_id, pr_number, day, status, is_draft, title, head_sha,
        created_at, updated_at, closed_at, merged_at, last_observed_at, source_run_id
      FROM pull_request_daily_snapshots_legacy;

      DROP TABLE pull_request_daily_snapshots_legacy;

      CREATE INDEX pull_request_daily_snapshots_repository_day_idx
        ON pull_request_daily_snapshots(repository_id, day);
      CREATE INDEX pull_request_daily_snapshots_repository_pr_day_idx
        ON pull_request_daily_snapshots(repository_id, pr_number, day);

      CREATE TABLE pull_request_lifecycle_state (
        repository_id TEXT NOT NULL,
        pr_number INTEGER NOT NULL CHECK (pr_number > 0),
        complete INTEGER NOT NULL CHECK (complete IN (0, 1)),
        fetched_at TEXT NOT NULL,
        source_run_id TEXT,
        PRIMARY KEY (repository_id, pr_number),
        FOREIGN KEY (repository_id, pr_number)
          REFERENCES pull_requests(repository_id, number) ON DELETE CASCADE,
        FOREIGN KEY (source_run_id)
          REFERENCES repository_sync_runs(id) ON DELETE SET NULL
      );

      CREATE TABLE pull_request_lifecycle_events (
        repository_id TEXT NOT NULL,
        pr_number INTEGER NOT NULL CHECK (pr_number > 0),
        event_id TEXT NOT NULL,
        event_type TEXT NOT NULL CHECK (
          event_type IN (
            'created', 'converted_to_draft', 'ready_for_review',
            'closed', 'reopened', 'merged'
          )
        ),
        occurred_at TEXT NOT NULL,
        PRIMARY KEY (repository_id, pr_number, event_id),
        FOREIGN KEY (repository_id, pr_number)
          REFERENCES pull_requests(repository_id, number) ON DELETE CASCADE
      );

      CREATE INDEX pull_request_lifecycle_events_replay_idx
        ON pull_request_lifecycle_events(repository_id, pr_number, occurred_at, event_id);
      CREATE INDEX pull_request_lifecycle_state_complete_idx
        ON pull_request_lifecycle_state(repository_id, complete, pr_number);
    `);
  },
};
