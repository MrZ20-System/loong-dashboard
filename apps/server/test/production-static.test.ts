import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openDatabase, type DatabaseClient } from "@loongboard/database";
import { afterEach, describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";
import type { SyncCoordinator } from "../src/sync-coordinator.js";

const apps: Array<ReturnType<typeof buildApp>> = [];
const databases: DatabaseClient[] = [];
const staticRoots: string[] = [];

const coordinator: SyncCoordinator = {
  start(repositoryId: string) {
    return {
      repositoryId,
      syncRunId: "production-static-test",
      startedAt: "2026-09-11T00:00:00.000Z",
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
  await Promise.all(staticRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function setup() {
  const staticRoot = await mkdtemp(join(tmpdir(), "loongboard-static-"));
  staticRoots.push(staticRoot);
  await writeFile(join(staticRoot, "index.html"), "<!doctype html><title>LoongBoard</title>");
  await writeFile(join(staticRoot, "asset.txt"), "static asset");

  const database = openDatabase(":memory:");
  databases.push(database);
  const app = buildApp(
    { database, timezone: "UTC", syncCoordinator: coordinator },
    { logger: false, staticRoot },
  );
  apps.push(app);
  return app;
}

describe("production static site", () => {
  it("serves assets and React deep links while preserving API 404 JSON", async () => {
    const app = await setup();

    const root = await app.inject({ method: "GET", url: "/" });
    expect(root.statusCode).toBe(200);
    expect(root.body).toContain("LoongBoard");

    const asset = await app.inject({ method: "GET", url: "/asset.txt" });
    expect(asset.statusCode).toBe(200);
    expect(asset.body).toBe("static asset");

    for (const url of ["/agent", "/repositories/vllm/merged", "/settings"]) {
      const deepLink = await app.inject({ method: "GET", url });
      expect(deepLink.statusCode).toBe(200);
      expect(deepLink.body).toContain("LoongBoard");
    }

    const missingApi = await app.inject({ method: "GET", url: "/api/does-not-exist" });
    expect(missingApi.statusCode).toBe(404);
    expect(missingApi.headers["content-type"]).toMatch(/^application\/json/);
    expect(missingApi.json()).toMatchObject({ statusCode: 404 });
  });
});
