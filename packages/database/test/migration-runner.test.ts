import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
