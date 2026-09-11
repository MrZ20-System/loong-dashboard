import type Database from "better-sqlite3";

import type { Migration } from "../migration-runner.js";

/** Persist the next safe admission time for a history stream. */
export const historyRateLimitRecoveryMigration: Migration = {
  id: "011_history_rate_limit_recovery",
  migrate(database: Database.Database): void {
    database.exec(`
      ALTER TABLE repository_history_state ADD COLUMN resume_after TEXT;
    `);
  },
};
