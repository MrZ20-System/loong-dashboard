import type Database from "better-sqlite3";

import type { Migration } from "../migration-runner.js";

/**
 * Lazy Issue detail cache. `issues.detail_synced_updated_at`
 * records the `updated_at` value whose body/comments are stored locally;
 * `issue_comments` is replaced transactionally whenever that marker is
 * stale, and cascades when the owning Issue row disappears.
 */
export const issueDetailCacheMigration: Migration = {
  id: "005_issue_detail_cache",
  migrate(database: Database.Database): void {
    const columns = database.prepare("PRAGMA table_info(issues)").all() as Array<{
      name: string;
    }>;
    if (!columns.some((column) => column.name === "detail_synced_updated_at")) {
      database.exec(`
        ALTER TABLE issues
          ADD COLUMN detail_synced_updated_at TEXT;
      `);
    }

    database.exec(`
      CREATE TABLE IF NOT EXISTS issue_comments (
        repository_id TEXT NOT NULL,
        issue_number INTEGER NOT NULL CHECK (issue_number > 0),
        github_comment_id INTEGER NOT NULL CHECK (github_comment_id > 0),
        author_login TEXT,
        body TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        url TEXT NOT NULL,
        PRIMARY KEY (repository_id, issue_number, github_comment_id),
        FOREIGN KEY (repository_id, issue_number)
          REFERENCES issues(repository_id, number) ON DELETE CASCADE
      );
    `);
  },
};
