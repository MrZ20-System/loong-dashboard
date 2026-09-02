import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  GhGitHubMetadataProvider,
  GitHubCommandError,
  GitHubGraphQLError,
  GitHubResponseError,
  derivePullRequestStatus,
} from "../src/index.js";

const repository = { owner: "acme", name: "rocket" } as const;
const syncStartedAt = "2024-06-10T00:00:00+08:00";
const rateLimit = { cost: 1, remaining: 4_999, resetAt: "2024-06-11T00:00:00+08:00" };
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("GhGitHubMetadataProvider", () => {
  it("fetches bootstrap PR streams with pagination, exact argv, and one command per page", async () => {
    const openNodes = Array.from({ length: 100 }, (_, index) =>
      pullRequestNode({
        id: `PR_${index + 1}`,
        number: index + 1,
        updatedAt: `2024-06-${String(10 - Math.floor(index / 10)).padStart(2, "0")}T00:${String(59 - (index % 10)).padStart(2, "0")}:00Z`,
      }),
    );
    const fixture = createFakeGh([
      pullRequestResponse(openNodes, { hasNextPage: false, endCursor: null }),
      pullRequestResponse([], { hasNextPage: false, endCursor: null }),
    ]);
    const provider = new GhGitHubMetadataProvider({ ghExecutable: fixture.executable });

    const pages = await collect(provider.fetchPullRequestUpdates({
      repository,
      mode: "bootstrap",
      syncStartedAt,
    }));

    expect(pages).toHaveLength(2);
    expect(pages[0]?.items).toHaveLength(100);
    expect(pages[1]?.items).toHaveLength(0);
    expect(pages[0]?.items[0]?.updatedAt).toBe("2024-06-10T00:59:00.000Z");
    expect(readCall(fixture.directory, 0).argv).toEqual([
      "api",
      "graphql",
      "--input",
      "-",
    ]);
    expect(readCall(fixture.directory, 1).argv).toEqual([
      "api",
      "graphql",
      "--input",
      "-",
    ]);
    expect(readCall(fixture.directory, 0).request.variables).toEqual({
      owner: "acme",
      name: "rocket",
      cursor: null,
      states: ["OPEN"],
    });
    expect(readCall(fixture.directory, 1).request.variables).toEqual({
      owner: "acme",
      name: "rocket",
      cursor: null,
      states: ["CLOSED", "MERGED"],
    });
    expect(readCall(fixture.directory, 0).request.query).toContain("changedFiles");
    expect(readCall(fixture.directory, 0).request.query).not.toContain("body");
    expect(readCall(fixture.directory, 0).request.query).not.toContain("gh pr view");
    expect(readCall(fixture.directory, 0).request.query).not.toContain("reviews");
    expect(readCall(fixture.directory, 0).request.query).not.toContain("timelineItems");
    expect(readFileSync(join(fixture.directory, "count"), "utf8")).toBe("2");
  });

  it("stops incremental PRs at the first older item without another command", async () => {
    const fixture = createFakeGh([
      pullRequestResponse(
        [
          pullRequestNode({ updatedAt: "2024-06-09T23:59:59Z", number: 2 }),
          pullRequestNode({ updatedAt: "2024-06-09T23:58:00Z", number: 1 }),
          pullRequestNode({ updatedAt: "2024-06-09T23:57:00Z", number: 3 }),
        ],
        { hasNextPage: true, endCursor: "cursor-1" },
      ),
    ]);
    const provider = new GhGitHubMetadataProvider({ ghExecutable: fixture.executable });

    const pages = await collect(provider.fetchPullRequestUpdates({
      repository,
      mode: "incremental",
      watermarkUpdatedAt: "2024-06-10T02:00:00+02:00",
    }));

    expect(pages).toHaveLength(1);
    expect(pages[0]?.items.map((item) => item.number)).toEqual([2, 1]);
    expect(readCall(fixture.directory, 0).request.variables).toEqual({
      owner: "acme",
      name: "rocket",
      cursor: null,
      states: ["OPEN", "CLOSED", "MERGED"],
    });
    expect(callExists(fixture.directory, 1)).toBe(false);
  });

  it("includes cutoff equality and normalizes all PR timestamps to UTC", async () => {
    const fixture = createFakeGh([
      pullRequestResponse([
        pullRequestNode({
          number: 10,
          updatedAt: "2024-06-09T16:00:00+08:00",
          createdAt: "2024-06-01T08:00:00+08:00",
          closedAt: "2024-06-09T16:00:00+08:00",
          mergedAt: "2024-06-09T16:00:00+08:00",
          author: null,
        }),
      ], { hasNextPage: false, endCursor: null }),
    ]);
    const provider = new GhGitHubMetadataProvider({ ghExecutable: fixture.executable });

    const [page] = await collect(provider.fetchPullRequestUpdates({
      repository,
      mode: "incremental",
      watermarkUpdatedAt: "2024-06-09T16:02:00+08:00",
    }));
    const [item] = page?.items ?? [];

    expect(item).toMatchObject({
      authorLogin: null,
      status: "merged",
      createdAt: "2024-06-01T00:00:00.000Z",
      updatedAt: "2024-06-09T08:00:00.000Z",
      closedAt: "2024-06-09T08:00:00.000Z",
      mergedAt: "2024-06-09T08:00:00.000Z",
    });
  });

  it("derives the four PR statuses in the frozen precedence order", () => {
    expect(
      derivePullRequestStatus({ state: "CLOSED", isDraft: false, mergedAt: "2024-01-01T00:00:00Z" }),
    ).toBe("merged");
    expect(
      derivePullRequestStatus({ state: "CLOSED", isDraft: true, mergedAt: null }),
    ).toBe("draft");
    expect(
      derivePullRequestStatus({ state: "CLOSED", isDraft: false, mergedAt: null }),
    ).toBe("closed");
    expect(
      derivePullRequestStatus({ state: "OPEN", isDraft: false, mergedAt: null }),
    ).toBe("open");
    expect(
      derivePullRequestStatus({ state: "MERGED", isDraft: false, mergedAt: null }),
    ).toBe("merged");
  });

  it("accepts raw MERGED PR state and sends all PR states for incremental sync", async () => {
    const fixture = createFakeGh([
      pullRequestResponse(
        [pullRequestNode({ state: "MERGED", mergedAt: null })],
        { hasNextPage: false, endCursor: null },
      ),
    ]);
    const provider = new GhGitHubMetadataProvider({ ghExecutable: fixture.executable });

    const [page] = await collect(provider.fetchPullRequestUpdates({
      repository,
      mode: "incremental",
      watermarkUpdatedAt: "2024-06-10T00:02:00Z",
    }));

    expect(page?.items[0]).toMatchObject({ stateRaw: "MERGED", status: "merged" });
    expect(readCall(fixture.directory, 0).request.variables.states).toEqual([
      "OPEN",
      "CLOSED",
      "MERGED",
    ]);
  });

  it("maps issue fields, nullable authors, pagination cursors, and rate limits", async () => {
    const fixture = createFakeGh([
      issueResponse(
        [issueNode({ number: 7, author: null, updatedAt: "2024-06-10T00:00:00Z" })],
        { hasNextPage: true, endCursor: "issue-cursor" },
      ),
      issueResponse(
        [issueNode({ number: 8, state: "CLOSED", comments: { totalCount: 3 } })],
        { hasNextPage: false, endCursor: null },
      ),
    ]);
    const provider = new GhGitHubMetadataProvider({ ghExecutable: fixture.executable });

    const pages = await collect(provider.fetchIssueUpdates({
      repository,
      mode: "incremental",
      watermarkUpdatedAt: "2024-06-10T00:02:00Z",
    }));

    expect(pages).toHaveLength(2);
    expect(pages[0]?.items[0]).toMatchObject({
      number: 7,
      state: "OPEN",
      status: "open",
      authorLogin: null,
      commentsCount: 0,
      updatedAt: "2024-06-10T00:00:00.000Z",
    });
    expect(pages[1]?.items[0]).toMatchObject({
      number: 8,
      state: "CLOSED",
      status: "closed",
      commentsCount: 3,
    });
    expect(readCall(fixture.directory, 1).request.variables).toEqual({
      owner: "acme",
      name: "rocket",
      cursor: "issue-cursor",
      states: ["OPEN", "CLOSED"],
    });
    expect(readCall(fixture.directory, 0).request.query).toContain("comments { totalCount }");
    expect(readCall(fixture.directory, 0).request.query).not.toContain("comments(first");
  });

  it.each([
    ["invalid JSON", "not-json", "stdout is not valid JSON"],
    ["invalid schema", JSON.stringify({ data: {} }), "data.repository"],
    [
      "invalid pageInfo",
      pullRequestResponse([pullRequestNode()], { hasNextPage: true, endCursor: null }),
      "endCursor is null",
    ],
    [
      "invalid repository",
      JSON.stringify({
        data: { repository: null, rateLimit },
      }),
      "data.repository",
    ],
  ])("rejects %s responses", async (_label, response, expected) => {
    const fixture = createFakeGh([response]);
    const provider = new GhGitHubMetadataProvider({ ghExecutable: fixture.executable });

    await expect(
      collect(provider.fetchPullRequestUpdates({
        repository,
        mode: "bootstrap",
        syncStartedAt,
      })),
    ).rejects.toThrow(expected);
  });

  it("rejects GraphQL partial data even when data is present", async () => {
    const fixture = createFakeGh([
      JSON.stringify({
        data: {
          repository: {
            pullRequests: {
              nodes: [],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
          rateLimit,
        },
        errors: [{ message: "repository access denied" }],
      }),
    ]);
    const provider = new GhGitHubMetadataProvider({ ghExecutable: fixture.executable });

    await expect(
      collect(provider.fetchPullRequestUpdates({
        repository,
        mode: "bootstrap",
        syncStartedAt,
      })),
    ).rejects.toBeInstanceOf(GitHubGraphQLError);
  });

  it("surfaces nonzero gh exit without returning an empty page", async () => {
    const fixture = createFakeGh([], 1, "gh: authentication required");
    const provider = new GhGitHubMetadataProvider({ ghExecutable: fixture.executable });

    await expect(
      collect(provider.fetchPullRequestUpdates({
        repository,
        mode: "bootstrap",
        syncStartedAt,
      })),
    ).rejects.toMatchObject({
      name: "GitHubCommandError",
      exitCode: 1,
      repository: "acme/rocket",
      stderr: "gh: authentication required",
    });
  });

  it("requires a watermark for incremental sync", async () => {
    const provider = new GhGitHubMetadataProvider({ ghExecutable: "/does/not/exist" });

    await expect(
      collect(provider.fetchIssueUpdates({ repository, mode: "incremental" })),
    ).rejects.toThrow("requires watermarkUpdatedAt");
  });

  it("does not accept unknown response fields", async () => {
    const response = JSON.parse(
      pullRequestResponse([pullRequestNode()], { hasNextPage: false, endCursor: null }),
    ) as { data: { repository: { pullRequests: { nodes: Array<Record<string, unknown>> } } } };
    response.data.repository.pullRequests.nodes[0]!.unexpected = "reject";
    const fixture = createFakeGh([JSON.stringify(response)]);
    const provider = new GhGitHubMetadataProvider({ ghExecutable: fixture.executable });

    await expect(
      collect(provider.fetchPullRequestUpdates({
        repository,
        mode: "bootstrap",
        syncStartedAt,
      })),
    ).rejects.toBeInstanceOf(GitHubResponseError);
  });
});

interface FixturePullRequestNode {
  id: string;
  number: number;
  title: string;
  url: string;
  state: "OPEN" | "CLOSED" | "MERGED";
  isDraft: boolean;
  author: { login: string } | null;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  mergedAt: string | null;
  baseRefName: string;
  headRefName: string;
  headRefOid: string;
  additions: number;
  deletions: number;
  changedFiles: number;
}

function pullRequestNode(
  overrides: Partial<FixturePullRequestNode> = {},
): FixturePullRequestNode {
  return { ...defaultPullRequestNode(), ...overrides };
}

function defaultPullRequestNode(): FixturePullRequestNode {
  return {
    id: "PR_1",
    number: 1,
    title: "Improve rocket",
    url: "https://github.com/acme/rocket/pull/1",
    state: "OPEN",
    isDraft: false,
    author: { login: "octocat" },
    createdAt: "2024-06-01T00:00:00Z",
    updatedAt: "2024-06-10T00:00:00Z",
    closedAt: null,
    mergedAt: null,
    baseRefName: "main",
    headRefName: "feature/rocket",
    headRefOid: "0123456789abcdef0123456789abcdef01234567",
    additions: 4,
    deletions: 2,
    changedFiles: 1,
  };
}

interface FixtureIssueNode {
  id: string;
  number: number;
  title: string;
  url: string;
  state: "OPEN" | "CLOSED";
  author: { login: string } | null;
  comments: { totalCount: number };
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
}

function issueNode(
  overrides: Partial<FixtureIssueNode> = {},
): FixtureIssueNode {
  return { ...defaultIssueNode(), ...overrides };
}

function defaultIssueNode(): FixtureIssueNode {
  return {
    id: "I_1",
    number: 1,
    title: "Track rocket",
    url: "https://github.com/acme/rocket/issues/1",
    state: "OPEN",
    author: { login: "octocat" },
    comments: { totalCount: 0 },
    createdAt: "2024-06-01T00:00:00Z",
    updatedAt: "2024-06-10T00:00:00Z",
    closedAt: null,
  };
}

function pullRequestResponse(
  nodes: readonly FixturePullRequestNode[],
  pageInfo: { hasNextPage: boolean; endCursor: string | null },
): string {
  return JSON.stringify({
    data: {
      repository: { pullRequests: { nodes, pageInfo } },
      rateLimit,
    },
  });
}

function issueResponse(
  nodes: readonly FixtureIssueNode[],
  pageInfo: { hasNextPage: boolean; endCursor: string | null },
): string {
  return JSON.stringify({
    data: {
      repository: { issues: { nodes, pageInfo } },
      rateLimit,
    },
  });
}

function createFakeGh(
  responses: readonly string[],
  exitCode = 0,
  stderr = "",
): { directory: string; executable: string } {
  const directory = mkdtempSync(join(tmpdir(), "loongboard-gh-"));
  temporaryDirectories.push(directory);
  const executable = join(directory, "gh-fake.cjs");
  const encodedResponses = JSON.stringify(responses);
  const script = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const directory = ${JSON.stringify(directory)};
const countPath = path.join(directory, "count");
const count = Number(fs.existsSync(countPath) ? fs.readFileSync(countPath, "utf8") : "0");
fs.writeFileSync(countPath, String(count + 1));
fs.writeFileSync(path.join(directory, "call-" + count + ".json"), JSON.stringify({ argv: process.argv.slice(2), request: JSON.parse(fs.readFileSync(0, "utf8")) }));
if (${exitCode} !== 0) {
  process.stderr.write(${JSON.stringify(stderr)});
  process.exit(${exitCode});
}
const responses = ${encodedResponses};
if (count >= responses.length) {
  process.stderr.write("unexpected fake gh call");
  process.exit(97);
}
process.stdout.write(responses[count]);
`;
  writeFileSync(executable, script);
  chmodSync(executable, 0o755);
  return { directory, executable };
}

function readCall(
  directory: string,
  index: number,
): { argv: string[]; request: { query: string; variables: Record<string, unknown> } } {
  return JSON.parse(readFileSync(join(directory, `call-${index}.json`), "utf8")) as {
    argv: string[];
    request: { query: string; variables: Record<string, unknown> };
  };
}

function callExists(directory: string, index: number): boolean {
  try {
    readFileSync(join(directory, `call-${index}.json`));
    return true;
  } catch {
    return false;
  }
}

async function collect<T>(iterable: AsyncIterable<{ items: readonly T[] }>): Promise<Array<{ items: readonly T[] }>> {
  const pages: Array<{ items: readonly T[] }> = [];
  for await (const page of iterable) {
    pages.push(page);
  }
  return pages;
}
