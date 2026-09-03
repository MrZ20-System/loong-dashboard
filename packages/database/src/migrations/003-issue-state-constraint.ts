import type Database from "better-sqlite3";

import type { Migration } from "../migration-runner.js";

/**
 * Migration 001 predates the persisted Issue status contract and cannot be
 * edited.  Triggers keep the forward migration small without rebuilding the
 * table (which would need to account for every existing foreign key).
 */
export const issueStateConstraintMigration: Migration = {
  id: "003_issue_state_constraint",
  migrate(database: Database.Database): void {
    const invalidRows = database
      .prepare("SELECT COUNT(*) AS count FROM issues WHERE state NOT IN ('open', 'closed')")
      .get() as { count: number };
    if (invalidRows.count > 0) {
      throw new Error("Cannot enforce issues.state: existing rows contain an invalid state");
    }

    database.exec(`
      CREATE TRIGGER issues_state_insert_check
      BEFORE INSERT ON issues
      WHEN NEW.state IS NULL OR NEW.state NOT IN ('open', 'closed')
      BEGIN
        SELECT RAISE(ABORT, 'issues.state must be open or closed');
      END;

      CREATE TRIGGER issues_state_update_check
      BEFORE UPDATE OF state ON issues
      WHEN NEW.state IS NULL OR NEW.state NOT IN ('open', 'closed')
      BEGIN
        SELECT RAISE(ABORT, 'issues.state must be open or closed');
      END;
    `);
  },
};
