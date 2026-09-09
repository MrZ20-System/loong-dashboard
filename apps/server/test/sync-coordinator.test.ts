import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  openDatabase,
  reconcileRepositories,
  type DatabaseClient,
} from "@loongboard/database";
import {
  RepositorySyncCoordinator,
  type RepositorySyncCoordinatorOptions,
} from "../src/sync-coordinator.js";
import type {
  FetchedIssueDetail,
  IssuePage,
  IssueSyncInput,
  PullRequestFilesInput,
  PullRequestFilesResult,
  PullRequestPage,
  PullRequestSyncInput,
  GitHubMetadataProvider,
} from "@loongboard/github";
import { afterEach, describe, expect, it } from "vitest";

const fixtures: Array<{ database: DatabaseClient; root: string }> = [];

afterEach(() => {
  for (const fixture of fixtures.splice(0)) {
    if (fixture.database.open) fixture.database.close();
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

function fixture(): DatabaseClient {
  const root = mkdtempSync(join(tmpdir(), "loongboard-sync-coordinator-"));
  const database = openDatabase(join(root, "state.sqlite3"));
  fixtures.push({ database, root });
  reconcileRepositories(database, [
    {
      key: "vllm",
      name: "vLLM",
      github: "openai/vllm",
      path: join(root, "vllm"),
      remote: "origin",
      defaultBranch: "main",
      worktreeSlots: 1,
    },
  ]);
  return database;
}

function providerFor(
  captures: { pull: PullRequestSyncInput | undefined; issue: IssueSyncInput | undefined },
): GitHubMetadataProvider {
  const rateLimit = { cost: 1, remaining: 4999, resetAt: "2026-09-10T00:00:00.000Z" };
  const pullPage: PullRequestPage = {
    items: [],
    pageInfo: { hasNextPage: false, endCursor: null },
    rateLimit,
  };
  const issuePage: IssuePage = {
    items: [],
    pageInfo: { hasNextPage: false, endCursor: null },
    rateLimit,
  };
  return {
    async *fetchPullRequestUpdates(input) {
      captures.pull = input;
      yield pullPage;
    },
    async *fetchIssueUpdates(input) {
      captures.issue = input;
      yield issuePage;
    },
    async fetchPullRequestFiles(
      _input: PullRequestFilesInput,
    ): Promise<PullRequestFilesResult[]> {
      return [];
    },
    async fetchIssueDetail(_input): Promise<FetchedIssueDetail> {
      throw new Error("not used");
    },
  };
}

describe("RepositorySyncCoordinator", () => {
  it("snapshots one configured initial window for both metadata streams", async () => {
    const database = fixture();
    const captures: {
      pull: PullRequestSyncInput | undefined;
      issue: IssueSyncInput | undefined;
    } = { pull: undefined, issue: undefined };
    const options: RepositorySyncCoordinatorOptions = {
      database,
      provider: providerFor(captures),
      lookbackDaysForRepository: () => 7,
      now: () => new Date("2026-09-09T10:00:00.000Z"),
    };
    const coordinator = new RepositorySyncCoordinator(options);

    coordinator.start("vllm");
    await coordinator.waitForIdle();

    expect(captures.pull).toMatchObject({ mode: "bootstrap", lookbackDays: 7 });
    expect(captures.issue).toMatchObject({ mode: "bootstrap", lookbackDays: 7 });
    await coordinator.close();
  });
});
