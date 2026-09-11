import type { SyncRun } from "@loongboard/database";

import type { SyncCoordinator } from "../../src/sync-coordinator.js";

function unexpectedCall(name: string): never {
  throw new Error(`Unexpected SyncCoordinator call: ${name}`);
}

function run(repositoryId: string, syncRunId: string): SyncRun {
  return {
    repositoryId,
    syncRunId,
    startedAt: "2026-09-11T00:00:00.000Z",
  };
}
/** Build a complete coordinator fake while keeping untested calls fail-fast. */
export function createSyncCoordinatorStub(
  overrides: Partial<SyncCoordinator> = {},
): SyncCoordinator {
  return {
    start: (repositoryId) => run(repositoryId, "test-sync-run"),
    startHistory: (repositoryId) => run(repositoryId, "test-history-run"),
    startFetchPullRequest: (repositoryId) => run(repositoryId, "test-fetch-run"),
    configureHistory: () => unexpectedCall("configureHistory"),
    pauseHistory: () => unexpectedCall("pauseHistory"),
    resumeHistory: (repositoryId) => run(repositoryId, "test-history-resume-run"),
    waitForIdle: async () => undefined,
    close: async () => undefined,
    ...overrides,
  };
}
