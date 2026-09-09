import type Database from "better-sqlite3";

import type { Migration } from "../migration-runner.js";

/**
 * Adds the conversation-origin metadata and scheduler conversation pointer.
 * The legacy scope_type column stays unchanged so databases created by the
 * first release remain readable; repository/domain origins use origin_kind
 * while old rows are backfilled from scope_type.
 */
export const agentRuntimeSchedulerMigration: Migration = {
  id: "006_agent_runtime_scheduler",
  migrate(database: Database.Database): void {
    database.exec(`
      ALTER TABLE agent_sessions ADD COLUMN origin_kind TEXT
        CHECK (origin_kind IS NULL OR origin_kind IN ('pr', 'issue', 'knowledge', 'general', 'repository', 'domain'));
      ALTER TABLE agent_sessions ADD COLUMN domain_id TEXT;
      ALTER TABLE agent_sessions ADD COLUMN origin_route TEXT;
      ALTER TABLE agent_sessions ADD COLUMN title TEXT;
      UPDATE agent_sessions SET origin_kind = scope_type WHERE origin_kind IS NULL;

      ALTER TABLE scheduled_tasks ADD COLUMN kind TEXT NOT NULL DEFAULT 'agent'
        CHECK (kind IN ('agent', 'system'));
      ALTER TABLE scheduled_tasks ADD COLUMN action TEXT;
      ALTER TABLE scheduled_tasks ADD COLUMN repository_id TEXT;
      ALTER TABLE scheduled_tasks ADD COLUMN conversation_id TEXT;

      ALTER TABLE scheduled_task_runs ADD COLUMN conversation_id TEXT;

      CREATE INDEX IF NOT EXISTS agent_sessions_origin_idx
        ON agent_sessions(origin_kind, repository_id, last_used_at DESC);
      CREATE INDEX IF NOT EXISTS scheduled_tasks_conversation_idx
        ON scheduled_tasks(conversation_id);
    `);
  },
};
