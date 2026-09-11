import type Database from "better-sqlite3";

import type { Migration } from "../migration-runner.js";

/** Cover the number-first and day/number list orderings without changing data. */
export const listQueryModesMigration: Migration = {
  id: "009_list_query_modes",
  migrate(database: Database.Database): void {
    database.exec(`
      CREATE INDEX IF NOT EXISTS pull_requests_repository_number_idx
        ON pull_requests(repository_id, number DESC);
      CREATE INDEX IF NOT EXISTS pull_request_daily_snapshots_repository_day_pr_idx
        ON pull_request_daily_snapshots(repository_id, day DESC, pr_number DESC);
    `);
  },
};
