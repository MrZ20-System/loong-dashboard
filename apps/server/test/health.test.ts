import { openDatabase, type DatabaseClient } from "@loongboard/database";
import type { SyncRun } from "@loongboard/database";
import { afterEach, describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";
import type { SyncCoordinator } from "../src/sync-coordinator.js";

const apps: ReturnType<typeof buildApp>[] = [];
const databases: DatabaseClient[] = [];

const healthDependencies: SyncCoordinator = {
  start(repositoryId: string): SyncRun {
    return {
      repositoryId,
      syncRunId: "health-test",
      startedAt: "2026-09-03T00:00:00.000Z",
    };
  },
  waitForIdle: async () => undefined,
  close: async () => undefined,
};

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  for (const database of databases.splice(0)) {
    if (database.open) database.close();
  }
});

describe("GET /api/health", () => {
  it("returns the exact shared health response", async () => {
    const database = openDatabase(":memory:");
    databases.push(database);
    const app = buildApp(
      {
        database,
        timezone: "UTC",
        syncCoordinator: healthDependencies,
      },
      { logger: false },
    );
    apps.push(app);

    const response = await app.inject({
      method: "GET",
      url: "/api/health",
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toMatch(
      /^application\/json(?:;\s*charset=utf-8)?$/,
    );
    expect(response.body).toBe('{"status":"ok"}');
    expect(response.json()).toEqual({ status: "ok" });
  });
});
