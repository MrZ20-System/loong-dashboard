import { openDatabase, type DatabaseClient } from "@loongboard/database";
import { afterEach, describe, expect, it } from "vitest";

import { buildTestApp } from "../src/app.js";
import { createSyncCoordinatorStub } from "./support/sync-coordinator.js";

const apps: ReturnType<typeof buildTestApp>[] = [];
const databases: DatabaseClient[] = [];

const healthDependencies = createSyncCoordinatorStub();

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
    const app = buildTestApp(
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
