import type Database from "better-sqlite3";

import type { Migration } from "../migration-runner.js";

export const initialSchemaMigration: Migration = {
  id: "001_initial_schema",
  migrate(database: Database.Database): void {
    database.exec(`
      CREATE TABLE repositories (
        id TEXT PRIMARY KEY,
        key TEXT NOT NULL UNIQUE,
        display_name TEXT NOT NULL,
        github_owner TEXT NOT NULL,
        github_name TEXT NOT NULL,
        local_path TEXT NOT NULL,
        remote_name TEXT NOT NULL,
        default_branch TEXT NOT NULL,
        worktree_slots INTEGER NOT NULL CHECK (worktree_slots >= 0),
        enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (github_owner, github_name)
      );

      CREATE TABLE repository_sync_state (
        repository_id TEXT NOT NULL,
        entity_kind TEXT NOT NULL CHECK (entity_kind IN ('pull_request', 'issue')),
        watermark_updated_at TEXT,
        last_attempt_at TEXT,
        last_success_at TEXT,
        status TEXT NOT NULL CHECK (status IN ('idle', 'running', 'failed')),
        last_error TEXT,
        rate_limit_remaining INTEGER CHECK (rate_limit_remaining IS NULL OR rate_limit_remaining >= 0),
        rate_limit_reset_at TEXT,
        PRIMARY KEY (repository_id, entity_kind),
        FOREIGN KEY (repository_id) REFERENCES repositories(id) ON DELETE CASCADE
      );

      CREATE TABLE pull_requests (
        repository_id TEXT NOT NULL,
        node_id TEXT NOT NULL,
        number INTEGER NOT NULL CHECK (number > 0),
        title TEXT NOT NULL,
        url TEXT NOT NULL,
        author_login TEXT,
        state_raw TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('draft', 'open', 'closed', 'merged')),
        is_draft INTEGER NOT NULL CHECK (is_draft IN (0, 1)),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        closed_at TEXT,
        merged_at TEXT,
        base_ref_name TEXT NOT NULL,
        head_ref_name TEXT NOT NULL,
        head_sha TEXT NOT NULL,
        additions INTEGER NOT NULL CHECK (additions >= 0),
        deletions INTEGER NOT NULL CHECK (deletions >= 0),
        changed_files_count INTEGER NOT NULL CHECK (changed_files_count >= 0),
        detail_body TEXT,
        PRIMARY KEY (repository_id, number),
        UNIQUE (repository_id, node_id),
        FOREIGN KEY (repository_id) REFERENCES repositories(id) ON DELETE CASCADE
      );

      CREATE TABLE pull_request_files (
        repository_id TEXT NOT NULL,
        pr_number INTEGER NOT NULL CHECK (pr_number > 0),
        head_sha TEXT NOT NULL,
        path TEXT NOT NULL,
        previous_path TEXT,
        change_type TEXT NOT NULL,
        additions INTEGER NOT NULL CHECK (additions >= 0),
        deletions INTEGER NOT NULL CHECK (deletions >= 0),
        PRIMARY KEY (repository_id, pr_number, head_sha, path),
        FOREIGN KEY (repository_id, pr_number)
          REFERENCES pull_requests(repository_id, number) ON DELETE CASCADE
      );

      CREATE TABLE domain_rules (
        id TEXT PRIMARY KEY,
        repository_id TEXT NOT NULL,
        name TEXT NOT NULL,
        color TEXT NOT NULL,
        position INTEGER NOT NULL CHECK (position >= 0),
        enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
        include_patterns_json TEXT NOT NULL,
        exclude_patterns_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (repository_id, id),
        UNIQUE (repository_id, name),
        FOREIGN KEY (repository_id) REFERENCES repositories(id) ON DELETE CASCADE
      );

      CREATE TABLE pull_request_domains (
        repository_id TEXT NOT NULL,
        pr_number INTEGER NOT NULL CHECK (pr_number > 0),
        domain_rule_id TEXT NOT NULL,
        classification_key TEXT NOT NULL,
        PRIMARY KEY (repository_id, pr_number, domain_rule_id),
        FOREIGN KEY (repository_id, pr_number)
          REFERENCES pull_requests(repository_id, number) ON DELETE CASCADE,
        FOREIGN KEY (repository_id, domain_rule_id)
          REFERENCES domain_rules(repository_id, id) ON DELETE CASCADE
      );

      CREATE TABLE issues (
        repository_id TEXT NOT NULL,
        node_id TEXT NOT NULL,
        number INTEGER NOT NULL CHECK (number > 0),
        title TEXT NOT NULL,
        url TEXT NOT NULL,
        author_login TEXT,
        state TEXT NOT NULL,
        comments_count INTEGER NOT NULL CHECK (comments_count >= 0),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        closed_at TEXT,
        detail_body TEXT,
        PRIMARY KEY (repository_id, number),
        UNIQUE (repository_id, node_id),
        FOREIGN KEY (repository_id) REFERENCES repositories(id) ON DELETE CASCADE
      );

      CREATE TABLE agent_sessions (
        id TEXT PRIMARY KEY,
        scope_type TEXT NOT NULL CHECK (scope_type IN ('pr', 'issue', 'knowledge', 'general')),
        repository_id TEXT,
        pr_number INTEGER,
        issue_number INTEGER,
        target_sha TEXT,
        knowledge_document_id TEXT,
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

      CREATE TABLE worktree_slots (
        id TEXT PRIMARY KEY,
        repository_id TEXT NOT NULL,
        slot_name TEXT NOT NULL,
        path TEXT NOT NULL UNIQUE,
        pr_number INTEGER,
        target_sha TEXT,
        busy_session_id TEXT,
        last_used_at TEXT,
        UNIQUE (repository_id, slot_name),
        FOREIGN KEY (repository_id) REFERENCES repositories(id) ON DELETE CASCADE,
        FOREIGN KEY (repository_id, pr_number)
          REFERENCES pull_requests(repository_id, number) ON DELETE SET NULL,
        FOREIGN KEY (busy_session_id) REFERENCES agent_sessions(id) ON DELETE SET NULL,
        CHECK (pr_number IS NOT NULL OR target_sha IS NULL)
      );

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
        prompt TEXT NOT NULL,
        workspace_path TEXT NOT NULL,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        reasoning_effort TEXT NOT NULL,
        enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
        last_run_at TEXT,
        next_run_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
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

      CREATE INDEX pull_requests_updated_number_idx
        ON pull_requests(repository_id, updated_at DESC, number DESC);
      CREATE INDEX pull_requests_status_updated_idx
        ON pull_requests(repository_id, status, updated_at DESC);
      CREATE INDEX pull_request_domains_filter_idx
        ON pull_request_domains(repository_id, domain_rule_id, pr_number);
      CREATE INDEX issues_updated_number_idx
        ON issues(repository_id, updated_at DESC, number DESC);
      CREATE INDEX pull_request_files_head_idx
        ON pull_request_files(repository_id, pr_number, head_sha);
      CREATE INDEX agent_messages_session_idx
        ON agent_messages(session_id, sequence);
      CREATE INDEX document_versions_document_idx
        ON document_versions(document_id, version_number DESC);
      CREATE INDEX scheduled_tasks_next_run_idx
        ON scheduled_tasks(enabled, next_run_at);
      CREATE INDEX scheduled_task_runs_task_idx
        ON scheduled_task_runs(task_id, scheduled_for DESC);
    `);
  },
};
