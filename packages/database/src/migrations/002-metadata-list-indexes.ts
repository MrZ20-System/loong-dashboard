import type Database from "better-sqlite3";

import type { Migration } from "../migration-runner.js";

/**
 * Indexes used by the Stage 1 metadata list queries.
 *
 * Migration 001 is intentionally immutable.  The original PR status index
 * remains available for existing databases; this migration adds the complete
 * ordering key (including the number tie-breaker) and the corresponding
 * Issue state index.
 */
export const metadataListIndexesMigration: Migration = {
  id: "002_metadata_list_indexes",
  migrate(database: Database.Database): void {
    database.exec(`
      CREATE INDEX pull_requests_status_updated_number_idx
        ON pull_requests(repository_id, status, updated_at DESC, number DESC);
      CREATE INDEX issues_state_updated_number_idx
        ON issues(repository_id, state, updated_at DESC, number DESC);
    `);
  },
};
