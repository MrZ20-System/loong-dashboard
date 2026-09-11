import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  openDatabase,
  reconcileRepositories,
  type DatabaseClient,
} from "@loongboard/database";
import { repositorySettingsSchema } from "@loongboard/contracts";
import { afterEach, describe, expect, it } from "vitest";

import { buildTestApp } from "../src/app.js";
import { SettingsController } from "../src/settings.js";
import { createSyncCoordinatorStub } from "./support/sync-coordinator.js";

const resources: Array<{ app: ReturnType<typeof buildTestApp>; database: DatabaseClient; root: string }> = [];

const syncCoordinator = createSyncCoordinatorStub();

afterEach(async () => {
  for (const resource of resources.splice(0)) {
    await resource.app.close();
    if (resource.database.open) resource.database.close();
    rmSync(resource.root, { recursive: true, force: true });
  }
});

describe("repository worktree settings routes", () => {
  it("projects GET and cleanup responses through the strict settings contract", async () => {
    const root = mkdtempSync(join(tmpdir(), "loongboard-worktree-settings-route-"));
    const database = openDatabase(join(root, "state.sqlite3"));
    reconcileRepositories(database, [{
      key: "loongboard",
      name: "LoongBoard",
      github: "acme/loongboard",
      path: join(root, "repository"),
      remote: "origin",
      defaultBranch: "main",
      worktreeSlots: 2,
    }]);
    const controller = new SettingsController({
      database,
      systemRoot: root,
      statePath: join(root, ".loong"),
      environment: {},
      worktrees: {
        inspect: () => ({
          configuredSlots: 2,
          idleCleanupTtlHours: 24,
          physicalSlots: 2,
          active: 1,
          idle: 1,
          dirty: 0,
          pendingRetirement: 0,
          pendingRetirementPaths: [],
          dirtyPaths: [],
          busyPaths: [join(root, "slot-01")],
          errors: [],
        }),
        cleanupUnused: () => ({
          configuredSlots: 2,
          idleCleanupTtlHours: 24,
          physicalSlots: 1,
          active: 1,
          idle: 0,
          dirty: 0,
          pendingRetirement: 0,
          pendingRetirementPaths: [],
          dirtyPaths: [],
          busyPaths: [join(root, "slot-01")],
          errors: [],
        }),
      },
    });
    const app = buildTestApp({ database, timezone: "UTC", syncCoordinator, settings: controller }, { logger: false });
    resources.push({ app, database, root });

    const getResponse = await app.inject({ method: "GET", url: "/api/repositories/loongboard/settings" });
    expect(getResponse.statusCode).toBe(200);
    const getBody = repositorySettingsSchema.parse(getResponse.json());
    expect(getBody.worktrees).toMatchObject({ physicalSlots: 2, active: 1, idle: 1 });
    expect(Object.keys(getBody.worktrees).sort()).toEqual([
      "active", "busyPaths", "configuredSlots", "dirty", "dirtyPaths", "errors",
      "idle", "idleCleanupTtlHours", "pendingRetirement", "pendingRetirementPaths", "physicalSlots",
    ]);

    const cleanupResponse = await app.inject({ method: "POST", url: "/api/repositories/loongboard/settings/worktrees/cleanup" });
    expect(cleanupResponse.statusCode).toBe(200);
    const cleanupBody = repositorySettingsSchema.parse(cleanupResponse.json());
    expect(cleanupBody.worktrees).toMatchObject({ physicalSlots: 1, active: 1, idle: 0 });
    expect(Object.keys(cleanupBody.worktrees)).not.toContain("removed");
    expect(Object.keys(cleanupBody.worktrees)).not.toContain("slots");
  });
});
