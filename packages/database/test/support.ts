import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openDatabase } from "../src/index.js";
import type {
  ConfiguredRepository,
  IssueMetadata,
  PullRequestMetadata,
} from "../src/index.js";

const directories: string[] = [];

export function databasePath(): string {
  const directory = mkdtempSync(join(tmpdir(), "loongboard-database-test-"));
  directories.push(directory);
  return join(directory, "loongboard.sqlite3");
}

export function repository(key: string, name = key): ConfiguredRepository {
  return {
    key,
    name,
    github: `example/${key}`,
    path: `/workspace/${key}`,
    remote: "origin",
    defaultBranch: "main",
    worktreeSlots: 2,
  };
}

export function pullRequest(
  number: number,
  updatedAt: string,
  overrides: Partial<PullRequestMetadata> = {},
): PullRequestMetadata {
  return {
    nodeId: `pr-node-${number}`,
    number,
    title: `Pull request ${number}`,
    url: `https://github.com/example/repo/pull/${number}`,
    authorLogin: "author",
    stateRaw: "OPEN",
    status: "open",
    isDraft: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt,
    closedAt: null,
    mergedAt: null,
    baseRefName: "main",
    headRefName: `feature-${number}`,
    headSha: `${number}`.padStart(40, "0"),
    additions: number,
    deletions: number,
    changedFilesCount: number,
    ...overrides,
  };
}

export function issue(
  number: number,
  updatedAt: string,
  overrides: Partial<IssueMetadata> = {},
): IssueMetadata {
  return {
    nodeId: `issue-node-${number}`,
    number,
    title: `Issue ${number}`,
    url: `https://github.com/example/repo/issues/${number}`,
    authorLogin: null,
    status: "open",
    commentsCount: number,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt,
    closedAt: null,
    ...overrides,
  };
}

export function comment(
  id: number,
  createdAt: string,
  body = "comment body text",
): {
  id: number;
  authorLogin: string | null;
  body: string;
  createdAt: string;
  updatedAt: string;
  url: string;
} {
  return {
    id,
    authorLogin: id === 1 ? "alice" : id === 2 ? "bob" : null,
    body,
    createdAt,
    updatedAt: createdAt,
    url: `https://github.com/example/repo/issues/7#issuecomment-${id}`,
  };
}

export function withDatabase<T>(
  callback: (database: ReturnType<typeof openDatabase>) => T,
): T {
  const database = openDatabase(databasePath());
  try {
    return callback(database);
  } finally {
    database.close();
  }
}

export function cleanupDatabaseDirectories(): void {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
}
