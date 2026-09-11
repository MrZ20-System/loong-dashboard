import { afterEach, describe, expect, it } from "vitest";
import {
  cleanupDatabaseDirectories,
  pullRequest,
  repository,
  withDatabase,
} from "./support.js";
import {
  getRepositorySyncState,
  listPullRequests,
  reconcileRepositories,
  upsertPullRequestPage,
} from "../src/index.js";

afterEach(cleanupDatabaseDirectories);

describe("repository persistence", () => {
  it("reconciles config idempotently, updates rows, and disables removed repositories", () => {
    withDatabase((database) => {
      const first = reconcileRepositories(
        database,
        [repository("alpha", "Alpha"), repository("beta", "Beta")],
        "2026-09-03T00:00:00.000Z",
      );
      expect(first.map((item) => [item.id, item.enabled])).toEqual([
        ["alpha", true],
        ["beta", true],
      ]);
      expect(getRepositorySyncState(database, "alpha", "pull_request").status).toBe("idle");
      expect(getRepositorySyncState(database, "beta", "issue").status).toBe("idle");

      upsertPullRequestPage(database, "beta", [pullRequest(7, "2026-09-02T00:00:00.000Z")]);
      expect(listPullRequests(database, "beta", { calendarTimeZone: "UTC" }).items.map(
        (item) => item.number,
      )).toEqual([7]);
      const unchanged = reconcileRepositories(
        database,
        [repository("alpha", "Alpha"), repository("beta", "Beta")],
        "2026-09-04T00:00:00.000Z",
      );
      expect(unchanged.find((item) => item.id === "alpha")?.updatedAt).toBe(
        "2026-09-03T00:00:00.000Z",
      );

      const changed = reconcileRepositories(
        database,
        [{ ...repository("alpha", "Alpha v2"), remote: "upstream", worktreeSlots: 4 }],
        "2026-09-05T00:00:00.000Z",
      );
      expect(changed).toEqual([
        expect.objectContaining({
          id: "alpha",
          displayName: "Alpha v2",
          remoteName: "upstream",
          worktreeSlots: 4,
          enabled: true,
          updatedAt: "2026-09-05T00:00:00.000Z",
        }),
        expect.objectContaining({ id: "beta", enabled: false }),
      ]);
      const restored = reconcileRepositories(
        database,
        [repository("beta", "Beta restored")],
        "2026-09-06T00:00:00.000Z",
      );
      expect(restored.find((item) => item.id === "beta")).toEqual(
        expect.objectContaining({
          id: "beta",
          displayName: "Beta restored",
          enabled: true,
          updatedAt: "2026-09-06T00:00:00.000Z",
        }),
      );
      expect(getRepositorySyncState(database, "beta", "issue").status).toBe("idle");
      expect(
        database
          .prepare(
            "SELECT repository_id, entity_kind FROM repository_sync_state ORDER BY repository_id, entity_kind",
          )
          .all(),
      ).toEqual([
        { repository_id: "alpha", entity_kind: "issue" },
        { repository_id: "alpha", entity_kind: "pull_request" },
        { repository_id: "beta", entity_kind: "issue" },
        { repository_id: "beta", entity_kind: "pull_request" },
      ]);
    });
  });
});
