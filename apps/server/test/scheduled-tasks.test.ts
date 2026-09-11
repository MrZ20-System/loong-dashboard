import { afterEach, describe, expect, it } from "vitest";

import {
  getScheduledTask,
  openDatabase,
  reconcileRepositories,
  type DatabaseClient,
} from "@loongboard/database";
import type { FastifyInstance } from "fastify";

import { buildTestApp } from "../src/app.js";
import { SchedulerEngine } from "../src/scheduler.js";
import { WorkspaceRunCoordinator } from "../src/workspace-run-coordinator.js";
import { createSyncCoordinatorStub } from "./support/sync-coordinator.js";

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
  const syncCoordinator = createSyncCoordinatorStub();
  const app = buildTestApp(
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
    expect(rejectedUpdate.json().error.message).toContain("managed by Settings");

    const bound = await app.inject({
      method: "POST",
      url: "/api/scheduled-tasks",
      payload: {
        ...baseSystemTask,
        action: "repository.sync",
        repositoryId: "repo",
      },
    });
    expect(bound.statusCode).toBe(201);
    expect(bound.json()).toMatchObject({
      action: "repository.sync",
      repositoryId: "repo",
    });
  });

  it("rejects generic PUT updates for system tasks", async () => {
    const { app, database } = setup();

    const created = await app.inject({
      method: "POST",
      url: "/api/scheduled-tasks",
      payload: {
        ...baseSystemTask,
        action: "knowledge.checkpoint",
      },
    });
    expect(created.statusCode).toBe(201);
    const taskId = created.json().id as string;

    const rejected = await app.inject({
      method: "PUT",
      url: `/api/scheduled-tasks/${taskId}`,
      payload: { cronExpression: "*/5 * * * *", enabled: true },
    });
    expect(rejected.statusCode).toBe(400);
    expect(rejected.json().error.message).toContain("managed by Settings");

    expect(getScheduledTask(database, taskId)).toMatchObject({
      enabled: false,
      cronExpression: "0 * * * *",
    });
  });

  it("rejects converting an Agent task into a system task without changing it", async () => {
    const { app, database } = setup();

    const created = await app.inject({
      method: "POST",
      url: "/api/scheduled-tasks",
      payload: {
        name: "Agent task",
        cronExpression: "0 * * * *",
        timezone: "UTC",
        kind: "agent",
        prompt: "Review the repository.",
        workspacePath: "/workspace/repo",
        provider: "provider",
        model: "model",
        reasoningEffort: "high",
        enabled: false,
      },
    });
    expect(created.statusCode).toBe(201);
    const taskId = created.json().id as string;
    const before = getScheduledTask(database, taskId);

    const rejected = await app.inject({
      method: "PUT",
      url: `/api/scheduled-tasks/${taskId}`,
      payload: { kind: "system", action: "knowledge.checkpoint" },
    });
    expect(rejected.statusCode).toBe(400);
    expect(rejected.json().error.message).toContain("managed by Settings");

    const after = getScheduledTask(database, taskId);
    expect(after).toEqual(before);
  });
});
