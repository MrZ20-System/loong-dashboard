import { afterEach, describe, expect, it } from "vitest";
import {
  cleanupDatabaseDirectories,
  issue,
  pullRequest,
  repository,
  withDatabase,
} from "./support.js";
import {
  getIssueActivityDays,
  getPullRequestActivityDays,
  reconcileRepositories,
  upsertIssuePage,
  upsertPullRequestPage,
} from "../src/index.js";

afterEach(cleanupDatabaseDirectories);

describe("activity persistence", () => {

  it("counts PR and Issue activity days in the requested IANA range", () => {
    withDatabase((database) => {
      reconcileRepositories(database, [repository("repo")]);
      upsertPullRequestPage(database, "repo", [
        pullRequest(1, "2026-03-08T05:00:00.000Z"),
        pullRequest(2, "2026-03-08T07:00:00.000Z"),
        pullRequest(3, "2026-03-09T04:00:00.000Z"),
      ]);
      upsertIssuePage(database, "repo", [
        issue(1, "2026-03-08T06:00:00.000Z"),
        issue(2, "2026-03-10T04:00:00.000Z"),
      ]);
      expect(
        getPullRequestActivityDays(database, "repo", {
          from: "2026-03-08",
          to: "2026-03-09",
          calendarTimeZone: "America/New_York",
        }),
      ).toEqual([
        { date: "2026-03-08", count: 2 },
        { date: "2026-03-09", count: 1 },
      ]);
      expect(
        getIssueActivityDays(database, "repo", {
          from: "2026-03-08",
          to: "2026-03-10",
          calendarTimeZone: "America/New_York",
        }),
      ).toEqual([
        { date: "2026-03-08", count: 1 },
        { date: "2026-03-10", count: 1 },
      ]);
    });
  });
});
