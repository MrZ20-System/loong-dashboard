import type Database from "better-sqlite3";

import type { Migration } from "../migration-runner.js";

const FOREIGN_KEY_VIOLATION_MESSAGE =
  "Phase 1 schema canonicalization produced foreign-key violations";

const REPOSITORY_SCOPED_ACTIONS = [
  "repository.sync",
  "repository.metadata-maintenance",
  "repository.worktrees.cleanup",
] as const;

function assertRepositoryScopedScheduledTasksCanMigrate(
  database: Database.Database,
): void {
  const invalidRows = database
    .prepare(
      `SELECT id, action FROM scheduled_tasks
       WHERE kind = 'system'
         AND CASE trim(action)
           WHEN 'repository-sync' THEN 'repository.sync'
           WHEN 'knowledge-checkpoint' THEN 'knowledge.checkpoint'
           ELSE trim(action)
         END IN (?, ?, ?)
         AND (
           repository_id IS NULL
           OR trim(repository_id) = ''
           OR NOT EXISTS (
             SELECT 1 FROM repositories
             WHERE repositories.id = scheduled_tasks.repository_id
           )
         )`,
    )
    .all(...REPOSITORY_SCOPED_ACTIONS) as Array<{
    id: string;
    action: string | null;
  }>;
  if (invalidRows.length > 0) {
    const details = invalidRows
      .map((row) => `${row.id} (${row.action ?? "NULL"})`)
      .join(", ");
    throw new Error(
      `Phase 1 schema canonicalization cannot migrate repository-scoped scheduled tasks without repository_id: ${details}`,
    );
  }
}

function assertForeignKeys(database: Database.Database): void {
  const violations = database.pragma("foreign_key_check") as Array<
    Record<string, unknown>
  >;
  if (violations.length > 0) {
    throw new Error(
      `${FOREIGN_KEY_VIOLATION_MESSAGE}: ${JSON.stringify(violations)}`,
    );
  }
}

/**
 * Rebuild the legacy scheduler/session tables into their canonical shape.
 *
 * SQLite cannot drop a referenced table while foreign keys are enabled.  The
 * migration therefore snapshots the complete dependency closure into TEMP
 * tables, drops the child tables before their parents, then recreates every
 * table with its final constraints and restores the rows.  The runner wraps
 * this method in one transaction; defer_foreign_keys postpones checks while
 * that transaction contains the intentional table replacement without
 * disabling foreign-key enforcement.
 */
export const phase1SchemaCanonicalizationMigration: Migration = {
  id: "014_phase1_schema_canonicalization",
  migrate(database: Database.Database): void {
    database.pragma("defer_foreign_keys = ON");
    assertRepositoryScopedScheduledTasksCanMigrate(database);

    database.exec(`
      CREATE TEMP TABLE phase1_agent_sessions_source AS
        SELECT * FROM agent_sessions;
      CREATE TEMP TABLE phase1_agent_messages_source AS
        SELECT * FROM agent_messages;
      CREATE TEMP TABLE phase1_knowledge_documents_source AS
        SELECT * FROM knowledge_documents;
      CREATE TEMP TABLE phase1_document_versions_source AS
        SELECT * FROM document_versions;
      CREATE TEMP TABLE phase1_scheduled_tasks_source AS
        SELECT * FROM scheduled_tasks;
      CREATE TEMP TABLE phase1_scheduled_task_runs_source AS
        SELECT * FROM scheduled_task_runs;
      CREATE TEMP TABLE phase1_worktree_slots_source AS
        SELECT * FROM worktree_slots;

      DROP TABLE agent_messages;
      DROP TABLE document_versions;
      DROP TABLE scheduled_task_runs;
      DROP TABLE scheduled_tasks;
      DROP TABLE worktree_slots;
      DROP TABLE knowledge_documents;
      DROP TABLE agent_sessions;
    `);

    database.exec(`
      CREATE TABLE knowledge_documents (
        id TEXT PRIMARY KEY,
        path TEXT NOT NULL UNIQUE,
        title TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        default_session_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (default_session_id) REFERENCES agent_sessions(id) ON DELETE SET NULL
      );

      CREATE TABLE agent_sessions (
        id TEXT PRIMARY KEY,
        origin_kind TEXT NOT NULL CHECK (
          origin_kind IN ('pr', 'issue', 'knowledge', 'general', 'repository', 'domain')
        ),
        repository_id TEXT,
        pr_number INTEGER,
        issue_number INTEGER,
        target_sha TEXT,
        knowledge_document_id TEXT,
        domain_id TEXT,
        origin_route TEXT,
        title TEXT,
        title_source TEXT NOT NULL DEFAULT 'manual'
          CHECK (title_source IN ('provisional', 'generated', 'manual')),
        dsh_session_id TEXT,
        dsh_home_path TEXT NOT NULL,
        workspace_path TEXT NOT NULL,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        reasoning_effort TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        last_used_at TEXT NOT NULL,
        FOREIGN KEY (repository_id) REFERENCES repositories(id) ON DELETE SET NULL,
        FOREIGN KEY (repository_id, pr_number)
          REFERENCES pull_requests(repository_id, number) ON DELETE SET NULL,
        FOREIGN KEY (repository_id, issue_number)
          REFERENCES issues(repository_id, number) ON DELETE SET NULL,
        FOREIGN KEY (knowledge_document_id)
          REFERENCES knowledge_documents(id) ON DELETE SET NULL,
        CHECK (
          (pr_number IS NULL AND issue_number IS NULL AND target_sha IS NULL)
          OR repository_id IS NOT NULL
        )
      );

      CREATE TABLE agent_messages (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        sequence INTEGER NOT NULL CHECK (sequence >= 0),
        role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'tool', 'system-status')),
        content_markdown TEXT NOT NULL,
        metadata_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE (session_id, sequence),
        FOREIGN KEY (session_id) REFERENCES agent_sessions(id) ON DELETE CASCADE
      );

      CREATE TABLE document_versions (
        id TEXT PRIMARY KEY,
        document_id TEXT NOT NULL,
        version_number INTEGER NOT NULL CHECK (version_number > 0),
        content TEXT NOT NULL,
        source TEXT NOT NULL CHECK (source IN ('manual', 'agent', 'external', 'restore')),
        agent_run_id TEXT,
        created_at TEXT NOT NULL,
        UNIQUE (document_id, version_number),
        FOREIGN KEY (document_id) REFERENCES knowledge_documents(id) ON DELETE CASCADE
      );

      CREATE TABLE scheduled_tasks (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        cron_expression TEXT NOT NULL,
        timezone TEXT NOT NULL,
        prompt TEXT,
        workspace_path TEXT,
        provider TEXT,
        model TEXT,
        reasoning_effort TEXT,
        kind TEXT NOT NULL DEFAULT 'agent' CHECK (kind IN ('agent', 'system')),
        action TEXT,
        repository_id TEXT,
        enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
        last_run_at TEXT,
        next_run_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (repository_id) REFERENCES repositories(id) ON DELETE SET NULL,
        CHECK (
          (kind = 'agent'
            AND prompt IS NOT NULL
            AND workspace_path IS NOT NULL
            AND provider IS NOT NULL
            AND model IS NOT NULL
            AND reasoning_effort IS NOT NULL
            AND action IS NULL)
          OR
          (kind = 'system'
            AND action IS NOT NULL
            AND (
              action NOT IN (
                'repository.sync',
                'repository.metadata-maintenance',
                'repository.worktrees.cleanup'
              )
              OR repository_id IS NOT NULL
            ))
        )
      );

      CREATE TABLE scheduled_task_runs (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        scheduled_for TEXT NOT NULL,
        started_at TEXT,
        finished_at TEXT,
        status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed', 'skipped')),
        agent_session_id TEXT,
        error TEXT,
        FOREIGN KEY (task_id) REFERENCES scheduled_tasks(id) ON DELETE CASCADE,
        FOREIGN KEY (agent_session_id) REFERENCES agent_sessions(id) ON DELETE SET NULL
      );

      CREATE TABLE worktree_slots (
        id TEXT PRIMARY KEY,
        repository_id TEXT NOT NULL,
        slot_name TEXT NOT NULL,
        path TEXT NOT NULL UNIQUE,
        pr_number INTEGER,
        target_sha TEXT,
        last_used_at TEXT,
        UNIQUE (repository_id, slot_name),
        FOREIGN KEY (repository_id) REFERENCES repositories(id) ON DELETE CASCADE,
        FOREIGN KEY (repository_id, pr_number)
          REFERENCES pull_requests(repository_id, number) ON DELETE SET NULL,
        CHECK (pr_number IS NOT NULL OR target_sha IS NULL)
      );

      CREATE INDEX agent_sessions_origin_idx
        ON agent_sessions(origin_kind, repository_id, last_used_at DESC);
      CREATE INDEX agent_messages_session_idx
        ON agent_messages(session_id, sequence);
      CREATE INDEX document_versions_document_idx
        ON document_versions(document_id, version_number DESC);
      CREATE INDEX scheduled_tasks_next_run_idx
        ON scheduled_tasks(enabled, next_run_at);
      CREATE INDEX scheduled_task_runs_task_idx
        ON scheduled_task_runs(task_id, scheduled_for DESC);
    `);

    database.exec(`
      INSERT INTO knowledge_documents (
        id, path, title, content_hash, default_session_id, created_at, updated_at
      )
      SELECT id, path, title, content_hash, default_session_id, created_at, updated_at
      FROM phase1_knowledge_documents_source;

      INSERT INTO agent_sessions (
        id, origin_kind, repository_id, pr_number, issue_number, target_sha,
        knowledge_document_id, domain_id, origin_route, title, title_source,
        dsh_session_id, dsh_home_path, workspace_path, provider, model,
        reasoning_effort, status, created_at, last_used_at
      )
      SELECT id, COALESCE(origin_kind, scope_type), repository_id, pr_number,
        issue_number, target_sha, knowledge_document_id, domain_id, origin_route,
        title, title_source, dsh_session_id, dsh_home_path, workspace_path,
        provider, model, reasoning_effort, status, created_at, last_used_at
      FROM phase1_agent_sessions_source;

      INSERT INTO agent_messages (
        id, session_id, sequence, role, content_markdown, metadata_json, created_at
      )
      SELECT id, session_id, sequence, role, content_markdown, metadata_json, created_at
      FROM phase1_agent_messages_source;

      INSERT INTO document_versions (
        id, document_id, version_number, content, source, agent_run_id, created_at
      )
      SELECT id, document_id, version_number, content, source, agent_run_id, created_at
      FROM phase1_document_versions_source;

      INSERT INTO scheduled_tasks (
        id, name, cron_expression, timezone, prompt, workspace_path, provider,
        model, reasoning_effort, kind, action, repository_id, enabled, last_run_at,
        next_run_at, created_at, updated_at
      )
      SELECT id, name, cron_expression, timezone,
        CASE WHEN kind = 'system' THEN NULL ELSE prompt END,
        CASE WHEN kind = 'system' THEN NULL ELSE workspace_path END,
        CASE WHEN kind = 'system' THEN NULL ELSE provider END,
        CASE WHEN kind = 'system' THEN NULL ELSE model END,
        CASE WHEN kind = 'system' THEN NULL ELSE reasoning_effort END,
        kind,
        CASE
          WHEN kind = 'agent' THEN NULL
          WHEN action = 'repository-sync' THEN 'repository.sync'
          WHEN action = 'knowledge-checkpoint' THEN 'knowledge.checkpoint'
          ELSE action
        END,
        CASE
          WHEN CASE
            WHEN kind = 'agent' THEN NULL
            WHEN action = 'repository-sync' THEN 'repository.sync'
            WHEN action = 'knowledge-checkpoint' THEN 'knowledge.checkpoint'
            ELSE action
          END IN (
            'repository.sync',
            'repository.metadata-maintenance',
            'repository.worktrees.cleanup'
          ) THEN repository_id
          WHEN repository_id IS NOT NULL AND EXISTS (
            SELECT 1 FROM repositories
            WHERE repositories.id = phase1_scheduled_tasks_source.repository_id
          ) THEN repository_id
          ELSE NULL
        END,
        enabled, last_run_at, next_run_at, created_at, updated_at
      FROM phase1_scheduled_tasks_source;

      INSERT INTO scheduled_task_runs (
        id, task_id, scheduled_for, started_at, finished_at, status,
        agent_session_id, error
      )
      SELECT id, task_id, scheduled_for, started_at, finished_at, status,
        CASE
          WHEN agent_session_id IS NOT NULL AND EXISTS (
            SELECT 1 FROM agent_sessions WHERE agent_sessions.id = phase1_scheduled_task_runs_source.agent_session_id
          ) THEN agent_session_id
          WHEN conversation_id IS NOT NULL AND EXISTS (
            SELECT 1 FROM agent_sessions WHERE agent_sessions.id = phase1_scheduled_task_runs_source.conversation_id
          ) THEN conversation_id
          ELSE NULL
        END,
        error
      FROM phase1_scheduled_task_runs_source;

      INSERT INTO worktree_slots (
        id, repository_id, slot_name, path, pr_number, target_sha, last_used_at
      )
      SELECT id, repository_id, slot_name, path, pr_number, target_sha, last_used_at
      FROM phase1_worktree_slots_source;

      DROP TABLE phase1_agent_sessions_source;
      DROP TABLE phase1_agent_messages_source;
      DROP TABLE phase1_knowledge_documents_source;
      DROP TABLE phase1_document_versions_source;
      DROP TABLE phase1_scheduled_tasks_source;
      DROP TABLE phase1_scheduled_task_runs_source;
      DROP TABLE phase1_worktree_slots_source;
    `);

    assertForeignKeys(database);
  },
};
