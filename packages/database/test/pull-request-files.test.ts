import { afterEach, describe, expect, it } from "vitest";
import {
  cleanupDatabaseDirectories,
  pullRequest,
  repository,
  withDatabase,
} from "./support.js";
import {
  listCurrentPullRequestEnrichmentStates,
  reconcileRepositories,
  replacePullRequestFiles,
  upsertPullRequestPage,
} from "../src/index.js";

afterEach(cleanupDatabaseDirectories);

  it("reports current PR head enrichment through the typed database API", () => {
    withDatabase((database) => {
      reconcileRepositories(database, [repository("repo")]);
      const first = pullRequest(1, "2026-09-03T00:00:00.000Z", {
        headSha: "a".repeat(40),
      });
      const second = pullRequest(2, "2026-09-03T00:00:00.000Z", {
        headSha: "b".repeat(40),
      });
      upsertPullRequestPage(database, "repo", [first, second]);

      expect(listCurrentPullRequestEnrichmentStates(database, "repo", [1, 2, 999])).toEqual([
        { number: 1, headSha: first.headSha, enriched: false },
        { number: 2, headSha: second.headSha, enriched: false },
      ]);
      replacePullRequestFiles(database, "repo", 1, first.headSha, [{
        path: "README.md",
        previousPath: null,
        changeType: "modified",
        additions: 1,
        deletions: 0,
      }], false);

      expect(listCurrentPullRequestEnrichmentStates(database, "repo", [1, 2])).toEqual([
        { number: 1, headSha: first.headSha, enriched: true },
        { number: 2, headSha: second.headSha, enriched: false },
      ]);
    });
  });
