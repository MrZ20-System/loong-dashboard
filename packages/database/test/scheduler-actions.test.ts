import { afterEach, describe, expect, it } from "vitest";

import {
  createScheduledTask,
  getScheduledTask,
  listScheduledTasks,
  openDatabase,
} from "../src/index.js";

const databases: Array<ReturnType<typeof openDatabase>> = [];

afterEach(() => {
  for (const database of databases.splice(0)) {
    if (database.open) database.close();
  }
});

describe("scheduled system action compatibility", () => {
  it("normalizes retired hyphenated actions when reading existing rows", () => {
    const database = openDatabase(":memory:");
    databases.push(database);
    createScheduledTask(database, {
      id: "system-repository-sync",
      name: "Repository sync",
      cronExpression: "0 * * * *",
      timezone: "UTC",
      prompt: "sync",
      workspacePath: "/workspace/repository",
      provider: "system",
      model: "system",
      reasoningEffort: "none",
      kind: "system",
      action: "repository.sync",
      enabled: false,
    });
    database
      .prepare("UPDATE scheduled_tasks SET action = ? WHERE id = ?")
      .run("repository-sync", "system-repository-sync");

    expect(getScheduledTask(database, "system-repository-sync")?.action).toBe(
      "repository.sync",
    );
    expect(listScheduledTasks(database)[0]?.action).toBe("repository.sync");
  });
});
