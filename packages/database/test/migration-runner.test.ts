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
  "issues",
  "knowledge_documents",
  "pull_request_domains",
  "pull_request_files",
  "pull_requests",
  "repositories",
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
      expect(ledger).toEqual([{ id: "001_initial_schema" }]);
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
      ]);
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
          state: "OPEN",
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
