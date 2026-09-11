import type Database from "better-sqlite3";

import type { Migration } from "../migration-runner.js";

/** Remove the obsolete Daily PR/EOD projection after migration 008 shipped. */
export const removeDailyProjectionsMigration: Migration = {
  id: "010_remove_daily_projections",
  migrate(database: Database.Database): void {
    database.exec(`
      DROP INDEX IF EXISTS pull_request_daily_snapshots_repository_day_idx;
      DROP INDEX IF EXISTS pull_request_daily_snapshots_repository_pr_day_idx;
      DROP INDEX IF EXISTS pull_request_daily_snapshots_repository_day_pr_idx;
      DROP INDEX IF EXISTS pull_request_lifecycle_events_replay_idx;
      DROP INDEX IF EXISTS pull_request_lifecycle_state_complete_idx;
      DROP INDEX IF EXISTS repository_history_coverage_day_idx;
      DROP TABLE IF EXISTS pull_request_lifecycle_events;
      DROP TABLE IF EXISTS pull_request_lifecycle_state;
      DROP TABLE IF EXISTS pull_request_daily_snapshots;
      DROP TABLE IF EXISTS repository_history_coverage;

      CREATE INDEX IF NOT EXISTS pull_requests_repository_merged_at_number_idx
        ON pull_requests(repository_id, merged_at DESC, number DESC)
        WHERE merged_at IS NOT NULL;
    `);
  },
};
