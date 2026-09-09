import { afterEach, describe, expect, it } from "vitest";

import {
  getRepository,
  listRepositories,
  openDatabase,
  reconcileRepositories,
  upsertIssuePage,
  upsertPullRequestPage,
  type IssueMetadata,
  type PullRequestMetadata,
} from "../src/index.js";

const databases: Array<ReturnType<typeof openDatabase>> = [];

afterEach(() => {
  for (const database of databases.splice(0)) {
    if (database.open) database.close();
  }
});

function repository() {
  return {
    key: "alpha",
    name: "Alpha",
    github: "example/alpha",
    path: "/workspace/alpha",
    remote: "origin",
    defaultBranch: "main",
    worktreeSlots: 1,
  };
}

function pullRequest(number: number): PullRequestMetadata {
  return {
    nodeId: `pr-${number}`,
    number,
    title: `PR ${number}`,
    url: `https://github.com/example/alpha/pull/${number}`,
    authorLogin: null,
    stateRaw: "OPEN",
    status: "open",
    isDraft: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    closedAt: null,
    mergedAt: null,
    baseRefName: "main",
    headRefName: `feature-${number}`,
    headSha: String(number).padStart(40, "0"),
    additions: 1,
    deletions: 0,
    changedFilesCount: 1,
  };
}

function issue(number: number): IssueMetadata {
  return {
    nodeId: `issue-${number}`,
    number,
    title: `Issue ${number}`,
    url: `https://github.com/example/alpha/issues/${number}`,
    authorLogin: null,
    status: "open",
    commentsCount: 0,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    closedAt: null,
  };
}

describe("repository navigation aggregates", () => {
  it("returns local pull request and Issue totals with repository rows", () => {
    const database = openDatabase(":memory:");
    databases.push(database);
    reconcileRepositories(database, [repository()]);
    upsertPullRequestPage(database, "alpha", [pullRequest(1), pullRequest(2)]);
    upsertIssuePage(database, "alpha", [issue(1), issue(2), issue(3)]);

    expect(listRepositories(database)[0]).toMatchObject({
      id: "alpha",
      pullRequestCount: 2,
      issueCount: 3,
    });
    expect(getRepository(database, "alpha")).toMatchObject({
      pullRequestCount: 2,
      issueCount: 3,
    });
  });
});
