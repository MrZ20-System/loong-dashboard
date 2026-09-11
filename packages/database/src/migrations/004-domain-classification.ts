import type Database from "better-sqlite3";

import type { Migration } from "../migration-runner.js";

/**
 * Changed-file storage and deterministic domain classification.
 * The `pull_request_files`, `domain_rules`, and `pull_request_domains` tables
 * and their indexes were already created by 001; the only additive schema
 * change is `pull_requests.files_truncated`, set when GitHub reports more
 * than 3000 files for one PR head.
 */
export const domainClassificationMigration: Migration = {
  id: "004_domain_classification",
  migrate(database: Database.Database): void {
    const columns = database.prepare("PRAGMA table_info(pull_requests)").all() as Array<{ name: string }>;
    if (columns.some((column) => column.name === "files_truncated")) {
      return;
    }
    database.exec(`
      ALTER TABLE pull_requests
        ADD COLUMN files_truncated INTEGER NOT NULL DEFAULT 0
        CHECK (files_truncated IN (0, 1));
    `);
  },
};
