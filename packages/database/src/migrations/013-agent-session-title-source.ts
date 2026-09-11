import type Database from "better-sqlite3";

import type { Migration } from "../migration-runner.js";

/**
 * Track whether a conversation title is safe for runtime discovery to
 * replace. Existing titles are deliberately treated as manual so an upgrade
 * never overwrites a user's previously chosen name.
 */
export const agentSessionTitleSourceMigration: Migration = {
  id: "013_agent_session_title_source",
  migrate(database: Database.Database): void {
    database.exec(`
      ALTER TABLE agent_sessions ADD COLUMN title_source TEXT NOT NULL DEFAULT 'manual'
        CHECK (title_source IN ('provisional', 'generated', 'manual'));
    `);
  },
};
