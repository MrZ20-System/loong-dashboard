import { afterEach, describe, expect, it } from "vitest";

import {
  openDatabase,
  reconcileRepositories,
  type DatabaseClient,
} from "@loongboard/database";
import type { FastifyInstance } from "fastify";

import { buildApp } from "../src/app.js";
import { SchedulerEngine } from "../src/scheduler.js";
import type { SyncCoordinator } from "../src/sync-coordinator.js";
import { WorkspaceRunCoordinator } from "../src/workspace-run-coordinator.js";

const databases: DatabaseClient[] = [];
const apps: FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  for (const database of databases.splice(0)) {
    if (database.open) database.close();
  }
});

function setup(): { app: FastifyInstance; database: DatabaseClient } {
  const database = openDatabase(":memory:");
  databases.push(database);
  reconcileRepositories(database, [
    {
      key: "repo",
      name: "Repository",
      github: "example/repo",
      path: "/workspace/repo",
      remote: "origin",
      defaultBranch: "main",
      worktreeSlots: 1,
    },
  ]);
  const scheduler = new SchedulerEngine({
    database,
    chats: {} as never,
    workspaceRuns: new WorkspaceRunCoordinator(),
    agentSessionsPath: "/tmp/loongboard-scheduled-task-tests",
  });
  const syncCoordinator = {
    start: async () => ({
      repositoryId: "repo",
      syncRunId: "sync-run",
      startedAt: "2026-09-11T00:00:00.000Z",
    }),
    close: async () => undefined,
  } as unknown as SyncCoordinator;
  const app = buildApp(
    {
      database,
      timezone: "UTC",
      syncCoordinator,
      scheduledTasks: {
        engine: scheduler,
        defaults: {
          provider: "provider",
          model: "model",
          reasoningEffort: "high",
        },
      },
    },
    { logger: false },
  );
  apps.push(app);
  return { app, database };
}

const baseSystemTask = {
  name: "System task",
  cronExpression: "0 * * * *",
  timezone: "UTC",
  kind: "system",
  enabled: false,
} as const;

describe("scheduled task repository bindings", () => {
  it("requires repositoryId on create and validates the merged update input", async () => {
    const { app } = setup();

    const missingCreate = await app.inject({
      method: "POST",
      url: "/api/scheduled-tasks",
      payload: { ...baseSystemTask, action: "repository.sync" },
    });
    expect(missingCreate.statusCode).toBe(400);
    expect(missingCreate.json().error.message).toContain("repositoryId");

    const unbound = await app.inject({
      method: "POST",
      url: "/api/scheduled-tasks",
      payload: { ...baseSystemTask, action: "knowledge.checkpoint" },
    });
    expect(unbound.statusCode).toBe(201);
    const unboundId = unbound.json().id as string;
    const rejectedUpdate = await app.inject({
      method: "PUT",
      url: `/api/scheduled-tasks/${unboundId}`,
      payload: { action: "repository.sync" },
    });
    expect(rejectedUpdate.statusCode).toBe(400);
    expect(rejectedUpdate.json().error.message).toContain("repositoryId");

    const bound = await app.inject({
      method: "POST",
      url: "/api/scheduled-tasks",
      payload: {
        ...baseSystemTask,
        action: "knowledge.checkpoint",
        repositoryId: "repo",
      },
    });
    expect(bound.statusCode).toBe(201);
    const boundId = bound.json().id as string;
    const acceptedUpdate = await app.inject({
      method: "PUT",
      url: `/api/scheduled-tasks/${boundId}`,
      payload: { action: "repository.sync" },
    });
    expect(acceptedUpdate.statusCode).toBe(200);
    expect(acceptedUpdate.json()).toMatchObject({
      action: "repository.sync",
      repositoryId: "repo",
    });
  });
});
