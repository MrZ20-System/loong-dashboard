import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import {
  agentSessions,
  createDrizzleDatabase,
  issues,
  openDatabase,
  repositories,
  runMigrations,
  scheduledTaskRuns,
  scheduledTasks,
} from "../src/index.js";
import { initialSchemaMigration } from "../src/migrations/001-initial-schema.js";
import { metadataListIndexesMigration } from "../src/migrations/002-metadata-list-indexes.js";
import { issueStateConstraintMigration } from "../src/migrations/003-issue-state-constraint.js";
import { domainClassificationMigration } from "../src/migrations/004-domain-classification.js";
import { issueDetailCacheMigration } from "../src/migrations/005-issue-detail-cache.js";
import { agentRuntimeSchedulerMigration } from "../src/migrations/006-agent-runtime-scheduler.js";
import { repositorySyncHistoryMigration } from "../src/migrations/007-repository-sync-history.js";
import { pullRequestLifecycleMigration } from "../src/migrations/008-pull-request-lifecycle.js";
import { listQueryModesMigration } from "../src/migrations/009-list-query-modes.js";
import { removeDailyProjectionsMigration } from "../src/migrations/010-remove-daily-projections.js";

const CORE_TABLES = [
  "agent_messages",
  "agent_sessions",
  "document_versions",
  "domain_rules",
  "issue_comments",
  "issues",
  "knowledge_documents",
  "pull_request_domains",
  "pull_request_files",
  "pull_requests",
  "repositories",
  "repository_history_state",
  "repository_maintenance_runs",
  "repository_sync_run_streams",
  "repository_sync_run_targets",
  "repository_sync_runs",
  "repository_sync_state",
  "scheduled_task_runs",
  "scheduled_tasks",
  "worktree_slots",
];

const temporaryDirectories: string[] = [];

interface IndexColumn {
  name: string;
  descending: number;
}

function readIndexColumns(
  database: ReturnType<typeof openDatabase>,
  indexName: string,
): IndexColumn[] {
  return database
    .prepare(`PRAGMA index_xinfo('${indexName}')`)
    .all()
    .filter((row) => (row as { key: number }).key === 1)
    .map((row) => ({
      name: (row as { name: string }).name,
      descending: (row as { desc: number }).desc,
    }));
}

function createDatabasePath(): string {
  const directory = mkdtempSync(join(tmpdir(), "loongboard-database-"));
  temporaryDirectories.push(directory);
  return join(directory, "loongboard.sqlite");
}

function createVersion010Database(databasePath: string): Database.Database {
  const database = new Database(databasePath);
  database.pragma("foreign_keys = ON");
  database.exec(`
    CREATE TABLE schema_migrations (
      id TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    )
  `);
  const migrations = [
    initialSchemaMigration,
    metadataListIndexesMigration,
    issueStateConstraintMigration,
    domainClassificationMigration,
    issueDetailCacheMigration,
    agentRuntimeSchedulerMigration,
    repositorySyncHistoryMigration,
    pullRequestLifecycleMigration,
    listQueryModesMigration,
    removeDailyProjectionsMigration,
  ];
  const record = database.prepare(
    "INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)",
  );
  for (const migration of migrations) {
    database.transaction(() => {
      migration.migrate(database);
      record.run(migration.id, "2026-09-01T00:00:00.000Z");
    })();
  }
  return database;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("database migrations", () => {
  it("creates every V1 core table and enables foreign keys on a fresh database", () => {
    const database = openDatabase(createDatabasePath());

    try {
      const tables = database
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name <> 'schema_migrations' ORDER BY name",
        )
        .all()
        .map((row) => (row as { name: string }).name);
      const foreignKeys = database.pragma("foreign_keys", { simple: true });
      const ledger = database
        .prepare("SELECT id FROM schema_migrations ORDER BY id")
        .all();

      expect(tables).toEqual(CORE_TABLES);
      expect(foreignKeys).toBe(1);
      expect(ledger).toEqual([
        { id: "001_initial_schema" },
        { id: "002_metadata_list_indexes" },
        { id: "003_issue_state_constraint" },
        { id: "004_domain_classification" },
        { id: "005_issue_detail_cache" },
        { id: "006_agent_runtime_scheduler" },
        { id: "007_repository_sync_history" },
        { id: "008_pull_request_lifecycle" },
        { id: "009_list_query_modes" },
        { id: "010_remove_daily_projections" },
        { id: "011_history_rate_limit_recovery" },
        { id: "012_metadata_retention" },
        { id: "013_agent_session_title_source" },
      ]);
    } finally {
      database.close();
    }
  });

  it("does not reapply an already recorded migration", () => {
    const database = openDatabase(createDatabasePath());

    try {
      const firstAppliedAt = database
        .prepare("SELECT applied_at FROM schema_migrations WHERE id = ?")
        .pluck()
        .get("001_initial_schema");

      runMigrations(database);

      const ledger = database
        .prepare("SELECT id, applied_at FROM schema_migrations ORDER BY id")
        .all();
      expect(ledger).toEqual([
        { id: "001_initial_schema", applied_at: firstAppliedAt },
        expect.objectContaining({ id: "002_metadata_list_indexes" }),
        expect.objectContaining({ id: "003_issue_state_constraint" }),
        expect.objectContaining({ id: "004_domain_classification" }),
        expect.objectContaining({ id: "005_issue_detail_cache" }),
        expect.objectContaining({ id: "006_agent_runtime_scheduler" }),
        expect.objectContaining({ id: "007_repository_sync_history" }),
        expect.objectContaining({ id: "008_pull_request_lifecycle" }),
        expect.objectContaining({ id: "009_list_query_modes" }),
        expect.objectContaining({ id: "010_remove_daily_projections" }),
        expect.objectContaining({ id: "011_history_rate_limit_recovery" }),
        expect.objectContaining({ id: "012_metadata_retention" }),
        expect.objectContaining({ id: "013_agent_session_title_source" }),
      ]);
      expect(
        database
          .prepare("PRAGMA table_info(repository_history_state)")
          .all()
          .some((row) => (row as { name: string }).name === "resume_after"),
      ).toBe(true);
    } finally {
      database.close();
    }
  });

  it("creates the four baseline list indexes with stable ordering columns", () => {
    const database = openDatabase(createDatabasePath());

    try {
      expect(
        readIndexColumns(database, "pull_requests_updated_number_idx"),
      ).toEqual([
        { name: "repository_id", descending: 0 },
        { name: "updated_at", descending: 1 },
        { name: "number", descending: 1 },
      ]);
      expect(
        readIndexColumns(database, "pull_requests_status_updated_idx"),
      ).toEqual([
        { name: "repository_id", descending: 0 },
        { name: "status", descending: 0 },
        { name: "updated_at", descending: 1 },
      ]);
      expect(
        readIndexColumns(database, "pull_request_domains_filter_idx"),
      ).toEqual([
        { name: "repository_id", descending: 0 },
        { name: "domain_rule_id", descending: 0 },
        { name: "pr_number", descending: 0 },
      ]);
      expect(readIndexColumns(database, "issues_updated_number_idx")).toEqual([
        { name: "repository_id", descending: 0 },
        { name: "updated_at", descending: 1 },
        { name: "number", descending: 1 },
      ]);
      expect(
        readIndexColumns(database, "pull_requests_status_updated_number_idx"),
      ).toEqual([
        { name: "repository_id", descending: 0 },
        { name: "status", descending: 0 },
        { name: "updated_at", descending: 1 },
        { name: "number", descending: 1 },
      ]);
      expect(
        readIndexColumns(database, "issues_state_updated_number_idx"),
      ).toEqual([
        { name: "repository_id", descending: 0 },
        { name: "state", descending: 0 },
        { name: "updated_at", descending: 1 },
        { name: "number", descending: 1 },
      ]);
    } finally {
      database.close();
    }
  });

  it("creates stable number-first and merged timeline ordering indexes", () => {
    const database = openDatabase(createDatabasePath());

    try {
      expect(readIndexColumns(database, "pull_requests_repository_number_idx")).toEqual([
        { name: "repository_id", descending: 0 },
        { name: "number", descending: 1 },
      ]);
      expect(readIndexColumns(database, "pull_requests_repository_merged_at_number_idx")).toEqual([
        { name: "repository_id", descending: 0 },
        { name: "merged_at", descending: 1 },
        { name: "number", descending: 1 },
      ]);
    } finally {
      database.close();
    }
  });

  it("adds retention markers and bounded maintenance indexes on a fresh database", () => {
    const database = openDatabase(createDatabasePath());

    try {
      expect(
        database
          .prepare("PRAGMA table_info(pull_requests)")
          .all()
          .map((row) => (row as { name: string }).name),
      ).toEqual(expect.arrayContaining(["archived_at", "payload_pruned_at"]));
      expect(
        database
          .prepare("PRAGMA table_info(issues)")
          .all()
          .map((row) => (row as { name: string }).name),
      ).toEqual(expect.arrayContaining(["archived_at", "payload_pruned_at"]));
      expect(
        database
          .prepare("PRAGMA table_info(repository_maintenance_runs)")
          .all()
          .map((row) => (row as { name: string }).name),
      ).toEqual(expect.arrayContaining([
        "id",
        "repository_id",
        "kind",
        "trigger",
        "status",
        "cutoff",
        "selector_json",
        "requested_at",
        "started_at",
        "finished_at",
        "pr_count",
        "issue_count",
        "files_deleted",
        "comments_deleted",
        "error",
      ]));
      expect(readIndexColumns(database, "pull_requests_retention_idx")).toEqual([
        { name: "repository_id", descending: 0 },
        { name: "archived_at", descending: 0 },
        { name: "status", descending: 0 },
        { name: "updated_at", descending: 0 },
      ]);
      expect(readIndexColumns(database, "issues_retention_idx")).toEqual([
        { name: "repository_id", descending: 0 },
        { name: "archived_at", descending: 0 },
        { name: "state", descending: 0 },
        { name: "updated_at", descending: 0 },
      ]);
    } finally {
      database.close();
    }
  });

  it("adds a manual-protected title source on fresh databases", () => {
    const database = openDatabase(createDatabasePath());

    try {
      const column = database
        .prepare("PRAGMA table_info(agent_sessions)")
        .all()
        .find((row) => (row as { name: string }).name === "title_source") as
        | { name: string; notnull: number; dflt_value: string }
        | undefined;
      expect(column).toEqual(expect.objectContaining({
        name: "title_source",
        notnull: 1,
        dflt_value: "'manual'",
      }));
    } finally {
      database.close();
    }
  });

  it("preserves old titles and marks upgraded rows manual", () => {
    const database = openDatabase(createDatabasePath());

    try {
      database
        .prepare(
          `INSERT INTO agent_sessions (
             id, scope_type, title, title_source, dsh_home_path, workspace_path,
             provider, model, reasoning_effort, status, created_at, last_used_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          "legacy-title-session",
          "general",
          "Existing user title",
          "manual",
          "/sessions/legacy-title",
          "/workspace",
          "deepseek-official",
          "model",
          "high",
          "idle",
          "2026-09-03T00:00:00.000Z",
          "2026-09-03T00:00:00.000Z",
        );

      database.exec("ALTER TABLE agent_sessions DROP COLUMN title_source");
      database.prepare("DELETE FROM schema_migrations WHERE id = ?").run(
        "013_agent_session_title_source",
      );
      runMigrations(database);

      expect(
        database
          .prepare("SELECT title, title_source FROM agent_sessions WHERE id = ?")
          .get("legacy-title-session"),
      ).toEqual({ title: "Existing user title", title_source: "manual" });
    } finally {
      database.close();
    }
  });

  it("upgrades a populated 010 database without losing durable state", () => {
    const databasePath = createDatabasePath();
    const settingsPath = join(dirname(databasePath), "settings.json");
    const settings = '{"repositories":{"repo-010":{"automaticSync":false}}}\n';
    writeFileSync(settingsPath, settings, "utf8");
    const database = createVersion010Database(databasePath);

    try {
      database.exec(`
        INSERT INTO repositories (
          id, key, display_name, github_owner, github_name, local_path,
          remote_name, default_branch, worktree_slots, enabled, created_at, updated_at
        ) VALUES (
          'repo-010', 'repo-010', 'Version 010', 'example', 'version-010',
          '/workspace/version-010', 'origin', 'main', 1, 1,
          '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z'
        );
        INSERT INTO pull_requests (
          repository_id, node_id, number, title, url, author_login, state_raw,
          status, is_draft, created_at, updated_at, closed_at, merged_at,
          base_ref_name, head_ref_name, head_sha, additions, deletions,
          changed_files_count, detail_body
        ) VALUES (
          'repo-010', 'pr-node-10', 10, 'Existing pull request',
          'https://github.com/example/version-010/pull/10', 'author', 'MERGED',
          'merged', 0, '2026-08-01T00:00:00.000Z', '2026-08-02T00:00:00.000Z',
          '2026-08-02T00:00:00.000Z', '2026-08-02T00:00:00.000Z',
          'main', 'feature', 'abc123', 4, 1, 1, 'pull body'
        );
        INSERT INTO issues (
          repository_id, node_id, number, title, url, author_login, state,
          comments_count, created_at, updated_at, closed_at, detail_body
        ) VALUES (
          'repo-010', 'issue-node-11', 11, 'Existing issue',
          'https://github.com/example/version-010/issues/11', 'author', 'closed', 2,
          '2026-08-01T00:00:00.000Z', '2026-08-03T00:00:00.000Z',
          '2026-08-03T00:00:00.000Z', 'issue body'
        );
        INSERT INTO agent_sessions (
          id, scope_type, repository_id, issue_number, dsh_home_path,
          workspace_path, provider, model, reasoning_effort, status,
          created_at, last_used_at, origin_kind, origin_route, title
        ) VALUES (
          'session-010', 'issue', 'repo-010', 11, '/sessions/session-010',
          '/workspace/version-010', 'deepseek-official', 'model', 'high', 'idle',
          '2026-09-01T00:00:00.000Z', '2026-09-01T01:00:00.000Z',
          'issue', '/repositories/repo-010/issues/11', 'Existing conversation'
        );
        INSERT INTO scheduled_tasks (
          id, name, cron_expression, timezone, prompt, workspace_path, provider,
          model, reasoning_effort, enabled, created_at, updated_at,
          kind, repository_id, conversation_id
        ) VALUES (
          'task-010', 'Existing task', '0 9 * * *', 'Asia/Shanghai', 'Run task.',
          '/workspace/version-010', 'deepseek-official', 'model', 'high', 1,
          '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z',
          'agent', 'repo-010', 'session-010'
        );
        INSERT INTO scheduled_task_runs (
          id, task_id, scheduled_for, started_at, finished_at, status,
          agent_session_id, conversation_id
        ) VALUES (
          'task-run-010', 'task-010', '2026-09-01T09:00:00.000Z',
          '2026-09-01T09:00:00.000Z', '2026-09-01T09:01:00.000Z',
          'completed', 'session-010', 'session-010'
        );
        INSERT INTO repository_sync_runs (
          id, repository_id, kind, trigger, status, requested_at,
          started_at, finished_at, selector_json
        ) VALUES (
          'history-run-010', 'repo-010', 'history', 'manual', 'completed',
          '2026-08-31T00:00:00.000Z', '2026-08-31T00:00:00.000Z',
          '2026-08-31T00:01:00.000Z', '{}'
        );
        INSERT INTO repository_history_state (
          repository_id, entity_kind, enabled, status, target_date,
          oldest_covered_day, cursor, recovery_anchor_updated_at, last_run_id,
          last_error, updated_at
        ) VALUES (
          'repo-010', 'pull_request', 1, 'paused', '2026-01-01', '2026-02-01',
          'opaque-cursor', '2026-02-01T00:00:00.000Z', 'history-run-010', NULL,
          '2026-09-01T00:00:00.000Z'
        );
      `);

      runMigrations(database);

      expect(database.prepare("SELECT title, archived_at, payload_pruned_at FROM pull_requests WHERE repository_id = 'repo-010' AND number = 10").get()).toEqual({
        title: "Existing pull request", archived_at: null, payload_pruned_at: null,
      });
      expect(database.prepare("SELECT title, archived_at, payload_pruned_at FROM issues WHERE repository_id = 'repo-010' AND number = 11").get()).toEqual({
        title: "Existing issue", archived_at: null, payload_pruned_at: null,
      });
      expect(database.prepare("SELECT title, title_source FROM agent_sessions WHERE id = 'session-010'").get()).toEqual({
        title: "Existing conversation", title_source: "manual",
      });
      expect(database.prepare("SELECT name, conversation_id FROM scheduled_tasks WHERE id = 'task-010'").get()).toEqual({
        name: "Existing task", conversation_id: "session-010",
      });
      expect(database.prepare("SELECT status, agent_session_id FROM scheduled_task_runs WHERE id = 'task-run-010'").get()).toEqual({
        status: "completed", agent_session_id: "session-010",
      });
      expect(database.prepare("SELECT status, cursor, last_run_id, resume_after FROM repository_history_state WHERE repository_id = 'repo-010' AND entity_kind = 'pull_request'").get()).toEqual({
        status: "paused", cursor: "opaque-cursor", last_run_id: "history-run-010", resume_after: null,
      });
      expect(readFileSync(settingsPath, "utf8")).toBe(settings);
    } finally {
      database.close();
    }
  });

  it("rejects rows whose foreign key target does not exist", () => {
    const database = openDatabase(createDatabasePath());

    try {
      const insert = database.prepare(
        "INSERT INTO scheduled_task_runs (id, task_id, scheduled_for, status) VALUES (?, ?, ?, ?)",
      );

      expect(() =>
        insert.run(
          "run-without-task",
          "missing-task",
          "2026-09-03T00:00:00.000Z",
          "running",
        ),
      ).toThrowError(/FOREIGN KEY constraint failed/);
    } finally {
      database.close();
    }
  });

  it("enforces the Issue state contract on inserts and updates", () => {
    const database = openDatabase(createDatabasePath());

    try {
      database
        .prepare(
          `INSERT INTO repositories
             (id, key, display_name, github_owner, github_name, local_path,
              remote_name, default_branch, worktree_slots, enabled, created_at,
              updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          "repo-state",
          "repo-state",
          "State Repository",
          "example",
          "state-repo",
          "/workspace/state-repo",
          "origin",
          "main",
          1,
          1,
          "2026-09-03T00:00:00.000Z",
          "2026-09-03T00:00:00.000Z",
        );

      const insert = database.prepare(
        `INSERT INTO issues
           (repository_id, node_id, number, title, url, author_login, state,
            comments_count, created_at, updated_at, closed_at, detail_body)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      expect(() =>
        insert.run(
          "repo-state",
          "issue-node-invalid",
          1,
          "Invalid state",
          "https://github.com/example/state-repo/issues/1",
          null,
          "OPEN",
          0,
          "2026-09-03T00:00:00.000Z",
          "2026-09-03T00:00:00.000Z",
          null,
          null,
        ),
      ).toThrowError(/issues\.state must be open or closed/);

      insert.run(
        "repo-state",
        "issue-node-valid",
        2,
        "Valid state",
        "https://github.com/example/state-repo/issues/2",
        null,
        "open",
        0,
        "2026-09-03T00:00:00.000Z",
        "2026-09-03T00:00:00.000Z",
        null,
        null,
      );
      expect(() =>
        database
          .prepare("UPDATE issues SET state = ? WHERE repository_id = ? AND number = ?")
          .run("CLOSED", "repo-state", 2),
      ).toThrowError(/issues\.state must be open or closed/);
    } finally {
      database.close();
    }
  });

  it("exposes the migrated repositories table through Drizzle", () => {
    const sqlite = openDatabase(createDatabasePath());

    try {
      const database = createDrizzleDatabase(sqlite);
      database
        .insert(repositories)
        .values({
          id: "repo-1",
          key: "loongboard",
          displayName: "LoongBoard",
          githubOwner: "MrZ20",
          githubName: "loong-dashboard",
          localPath: "/workspace/loong-dashboard",
          remoteName: "origin",
          defaultBranch: "main",
          worktreeSlots: 2,
          enabled: true,
          createdAt: "2026-09-02T00:00:00.000Z",
          updatedAt: "2026-09-02T00:00:00.000Z",
        })
        .run();

      expect(database.select().from(repositories).all()).toEqual([
        expect.objectContaining({
          id: "repo-1",
          key: "loongboard",
          enabled: true,
        }),
      ]);
    } finally {
      sqlite.close();
    }
  });

  it("maps scheduled tasks and runs through Drizzle", () => {
    const sqlite = openDatabase(createDatabasePath());

    try {
      const database = createDrizzleDatabase(sqlite);
      database
        .insert(scheduledTasks)
        .values({
          id: "task-1",
          name: "Daily report",
          cronExpression: "0 9 * * *",
          timezone: "Asia/Shanghai",
          prompt: "Create the daily report.",
          workspacePath: "/workspace",
          provider: "deepseek-official",
          model: "deepseek-v4-flash",
          reasoningEffort: "high",
          enabled: true,
          createdAt: "2026-09-03T00:00:00.000Z",
          updatedAt: "2026-09-03T00:00:00.000Z",
        })
        .run();
      database
        .insert(scheduledTaskRuns)
        .values({
          id: "run-1",
          taskId: "task-1",
          scheduledFor: "2026-09-03T01:00:00.000Z",
          status: "running",
        })
        .run();

      expect(database.select().from(scheduledTaskRuns).all()).toEqual([
        expect.objectContaining({
          id: "run-1",
          taskId: "task-1",
          status: "running",
        }),
      ]);
    } finally {
      sqlite.close();
    }
  });

  it("maps an Issue Chat session to its repository issue identity", () => {
    const sqlite = openDatabase(createDatabasePath());

    try {
      const database = createDrizzleDatabase(sqlite);
      database
        .insert(repositories)
        .values({
          id: "repo-issue",
          key: "issue-repo",
          displayName: "Issue Repository",
          githubOwner: "example",
          githubName: "issue-repo",
          localPath: "/workspace/issue-repo",
          remoteName: "origin",
          defaultBranch: "main",
          worktreeSlots: 1,
          enabled: true,
          createdAt: "2026-09-03T00:00:00.000Z",
          updatedAt: "2026-09-03T00:00:00.000Z",
        })
        .run();
      const issueSession = {
        id: "issue-session-42",
        scopeType: "issue" as const,
        repositoryId: "repo-issue",
        issueNumber: 42,
        dshHomePath: "/workspace/.loong/sessions/issue-session-42",
        workspacePath: "/workspace/issue-repo",
        provider: "deepseek-official",
        model: "deepseek-v4-flash",
        reasoningEffort: "high",
        status: "idle",
        createdAt: "2026-09-03T00:00:00.000Z",
        lastUsedAt: "2026-09-03T00:00:00.000Z",
      };

      expect(() =>
        database.insert(agentSessions).values(issueSession).run(),
      ).toThrowError(/FOREIGN KEY constraint failed/);
      database
        .insert(issues)
        .values({
          repositoryId: "repo-issue",
          nodeId: "issue-node-42",
          number: 42,
          title: "Track issue sessions",
          url: "https://github.com/example/issue-repo/issues/42",
          state: "open",
          commentsCount: 0,
          createdAt: "2026-09-03T00:00:00.000Z",
          updatedAt: "2026-09-03T00:00:00.000Z",
        })
        .run();
      database
        .insert(agentSessions)
        .values(issueSession)
        .run();

      expect(database.select().from(agentSessions).all()).toEqual([
        expect.objectContaining({
          id: "issue-session-42",
          repositoryId: "repo-issue",
          issueNumber: 42,
        }),
      ]);
    } finally {
      sqlite.close();
    }
  });
});
