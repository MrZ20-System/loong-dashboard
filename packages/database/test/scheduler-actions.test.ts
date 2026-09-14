import { afterEach, describe, expect, it } from "vitest";

import {
  createScheduledTask,
  getScheduledTask,
  listScheduledTasks,
  openDatabase,
  reconcileRepositories,
  updateScheduledTask,
} from "../src/index.js";

const databases: Array<ReturnType<typeof openDatabase>> = [];

afterEach(() => {
  for (const database of databases.splice(0)) {
    if (database.open) database.close();
  }
});

describe("scheduled system actions", () => {
  function repository() {
    return {
      key: "repo",
      name: "Repository",
      github: "example/repo",
      path: "/workspace/repo",
      remote: "origin",
      defaultBranch: "main",
      worktreeSlots: 1,
    };
  }

  it("persists canonical dotted actions without runtime normalization", () => {
    const database = openDatabase(":memory:");
    databases.push(database);
    reconcileRepositories(database, [repository()]);
    createScheduledTask(database, {
      id: "system-repository-sync",
      name: "Repository sync",
      cronExpression: "0 * * * *",
      timezone: "UTC",
      kind: "system",
      action: "repository.sync",
      repositoryId: "repo",
      enabled: false,
    });
    expect(getScheduledTask(database, "system-repository-sync")?.action).toBe(
      "repository.sync",
    );
    expect(getScheduledTask(database, "system-repository-sync")).toMatchObject({
      prompt: null,
      workspacePath: null,
      provider: null,
      model: null,
      reasoningEffort: null,
    });
    expect(listScheduledTasks(database)[0]?.action).toBe("repository.sync");
  });

  it("enforces repository bindings for repository-scoped actions", () => {
    const database = openDatabase(":memory:");
    databases.push(database);
    reconcileRepositories(database, [repository()]);

    expect(() =>
      createScheduledTask(database, {
        id: "missing-repository",
        name: "Missing repository",
        cronExpression: "0 * * * *",
        timezone: "UTC",
        kind: "system",
        action: "repository.sync",
        enabled: false,
      }),
    ).toThrow();

    createScheduledTask(database, {
      id: "unbound-system",
      name: "Unbound system",
      cronExpression: "0 * * * *",
      timezone: "UTC",
      kind: "system",
      action: "personal-data.checkpoint",
      enabled: false,
    });
    expect(() =>
      updateScheduledTask(database, "unbound-system", {
        action: "repository.sync",
      }),
    ).toThrow();
  });

  it("preserves an existing repository binding for an action-only update", () => {
    const database = openDatabase(":memory:");
    databases.push(database);
    reconcileRepositories(database, [repository()]);
    createScheduledTask(database, {
      id: "bound-system",
      name: "Bound system",
      cronExpression: "0 * * * *",
      timezone: "UTC",
      kind: "system",
      action: "personal-data.checkpoint",
      repositoryId: "repo",
      enabled: false,
    });

    expect(updateScheduledTask(database, "bound-system", {
      action: "repository.sync",
    })).toMatchObject({ action: "repository.sync", repositoryId: "repo" });
  });
});
