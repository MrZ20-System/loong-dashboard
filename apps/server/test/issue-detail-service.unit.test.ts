import { openDatabase, reconcileRepositories, upsertIssuePage } from "@loongboard/database";
import type {
  FetchedIssueDetail,
  GitHubMetadataProvider,
} from "@loongboard/github";
import { afterEach, describe, expect, it, vi } from "vitest";

import { IssueDetailService } from "../src/issue-detail-service.js";

const databases: Array<ReturnType<typeof openDatabase>> = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

function setup() {
  const database = openDatabase(":memory:");
  databases.push(database);
  reconcileRepositories(database, [{
    key: "repo",
    name: "Repository",
    github: "owner/repo",
    path: "/tmp/repo",
    remote: "origin",
    defaultBranch: "main",
    worktreeSlots: 2,
  }], "2026-01-01T00:00:00.000Z");
  upsertIssuePage(database, "repo", [{
    nodeId: "issue-node",
    number: 7,
    title: "Issue",
    url: "https://github.com/owner/repo/issues/7",
    authorLogin: "owner",
    status: "open",
    commentsCount: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-02T00:00:00.000Z",
    closedAt: null,
  }]);
  return database;
}

function provider(detail: FetchedIssueDetail): GitHubMetadataProvider {
  return {
    fetchPullRequestUpdates: async function* () {},
    fetchIssueUpdates: async function* () {},
    fetchPullRequestFiles: async () => [],
    fetchIssueDetail: vi.fn(async () => detail),
  };
}

describe("IssueDetailService", () => {
  it("coalesces concurrent stale-cache refreshes", async () => {
    const database = setup();
    const detail: FetchedIssueDetail = {
      number: 7,
      title: "Issue refreshed",
      url: "https://github.com/owner/repo/issues/7",
      state: "open",
      authorLogin: "owner",
      commentsCount: 1,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-02T00:00:00.000Z",
      closedAt: null,
      body: "Body",
      comments: [{
        id: 11,
        authorLogin: "reviewer",
        body: "Comment",
        createdAt: "2026-01-02T01:00:00.000Z",
        updatedAt: "2026-01-02T01:00:00.000Z",
        url: "https://github.com/owner/repo/issues/7#issuecomment-11",
      }],
    };
    const github = provider(detail);
    const service = new IssueDetailService({ database, github });

    const [first, second] = await Promise.all([
      service.get("repo", 7),
      service.get("repo", 7),
    ]);

    expect(github.fetchIssueDetail).toHaveBeenCalledTimes(1);
    expect(first).toEqual(second);
    expect(first?.detailBody).toBe("Body");
    expect(first?.comments).toHaveLength(1);
  });

  it("serves a fresh cache without calling GitHub again", async () => {
    const database = setup();
    const detail: FetchedIssueDetail = {
      number: 7,
      title: "Issue",
      url: "https://github.com/owner/repo/issues/7",
      state: "open",
      authorLogin: "owner",
      commentsCount: 0,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-02T00:00:00.000Z",
      closedAt: null,
      body: "Cached",
      comments: [],
    };
    const github = provider(detail);
    const service = new IssueDetailService({ database, github });
    await service.get("repo", 7);
    vi.mocked(github.fetchIssueDetail).mockClear();

    const cached = await service.get("repo", 7);

    expect(cached?.detailBody).toBe("Cached");
    expect(github.fetchIssueDetail).not.toHaveBeenCalled();
  });
});
