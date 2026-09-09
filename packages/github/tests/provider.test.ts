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
  GitHubHttpError,
  GitHubResponseError,
  derivePullRequestStatus,
  type GitHubFetch,
  type GhGitHubMetadataProviderOptions,
} from "../src/index.js";

const repository = { owner: "acme", name: "rocket" } as const;
const syncStartedAt = "2024-06-10T00:00:00+08:00";
const rateLimit = { cost: 1, remaining: 4_999, resetAt: "2024-06-11T00:00:00+08:00" };
const apiBaseUrl = "https://api.github.com";
const graphQlUrl = `${apiBaseUrl}/graphql`;
const originalGitHubToken = process.env.GITHUB_TOKEN;
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
  if (originalGitHubToken === undefined) {
    delete process.env.GITHUB_TOKEN;
  } else {
    process.env.GITHUB_TOKEN = originalGitHubToken;
  }
});

describe("GhGitHubMetadataProvider", () => {
  it("fetches the initial PR window across all states with exact HTTP requests", async () => {
    const openNodes = Array.from({ length: 100 }, (_, index) =>
      pullRequestNode({
        id: `PR_${index + 1}`,
        number: index + 1,
        updatedAt: `2024-06-${String(10 - Math.floor(index / 10)).padStart(2, "0")}T00:${String(59 - (index % 10)).padStart(2, "0")}:00Z`,
      }),
    );
    const http = createFakeHttp([
      httpJson(pullRequestResponse(openNodes, { hasNextPage: false, endCursor: null })),
    ]);
    const provider = createProvider(http);

    const pages = await collect(provider.fetchPullRequestUpdates({
      repository,
      mode: "bootstrap",
      syncStartedAt,
    }));

    expect(pages).toHaveLength(1);
    expect(pages[0]?.items).toHaveLength(100);
    expect(pages[0]?.items[0]?.updatedAt).toBe("2024-06-10T00:59:00.000Z");
    expect(http.calls).toHaveLength(1);
    expect(http.calls[0]).toMatchObject({
      url: graphQlUrl,
      method: "POST",
      headers: {
        authorization: "Bearer test-token",
        accept: "application/vnd.github+json",
        "content-type": "application/json",
      },
    });
    expect(requestBody(http, 0).variables).toEqual({
      owner: "acme",
      name: "rocket",
      cursor: null,
      states: ["OPEN", "CLOSED", "MERGED"],
    });
    expect(requestBody(http, 0).query).toContain("changedFiles");
    expect(requestBody(http, 0).query).not.toContain("body");
    expect(requestBody(http, 0).query).not.toContain("gh pr view");
    expect(requestBody(http, 0).query).not.toContain("reviews");
    expect(requestBody(http, 0).query).not.toContain("timelineItems");
  });

  it("keeps the 30-day initial PR boundary across all states and stops before the next page", async () => {
    const http = createFakeHttp([
      httpJson(pullRequestResponse(
        [
          pullRequestNode({
            id: "PR_OPEN",
            number: 91,
            state: "OPEN",
            updatedAt: "2024-05-11T00:00:00Z",
          }),
          pullRequestNode({
            id: "PR_CLOSED",
            number: 92,
            state: "CLOSED",
            updatedAt: "2024-05-11T00:00:00Z",
          }),
          pullRequestNode({
            id: "PR_BOUNDARY",
            number: 90,
            state: "MERGED",
            mergedAt: "2024-05-11T00:00:00Z",
            updatedAt: "2024-05-11T00:00:00Z",
          }),
          pullRequestNode({
            id: "PR_OLD",
            number: 89,
            state: "CLOSED",
            updatedAt: "2024-05-10T23:59:59Z",
          }),
        ],
        { hasNextPage: true, endCursor: "initial-pr-next" },
      )),
    ]);
    const provider = createProvider(http);

    const pages = await collect(provider.fetchPullRequestUpdates({
      repository,
      mode: "bootstrap",
      syncStartedAt: "2024-06-10T00:00:00Z",
    }));

    expect(pages).toHaveLength(1);
    expect(pages[0]?.items).toHaveLength(3);
    expect(pages[0]?.items.map((item) => item.status)).toEqual([
      "open",
      "closed",
      "merged",
    ]);
    expect(pages[0]?.items[2]).toMatchObject({
      number: 90,
      stateRaw: "MERGED",
      status: "merged",
      updatedAt: "2024-05-11T00:00:00.000Z",
    });
    expect(requestBody(http, 0).variables.states).toEqual(["OPEN", "CLOSED", "MERGED"]);
    expect(http.calls).toHaveLength(1);
  });

  it("stops incremental PRs at the first older item without another command", async () => {
    const http = createFakeHttp([
      httpJson(pullRequestResponse(
        [
          pullRequestNode({ updatedAt: "2024-05-10T00:01:59Z", number: 2 }),
          pullRequestNode({ updatedAt: "2024-05-10T00:01:00Z", number: 1 }),
          pullRequestNode({ updatedAt: "2024-05-09T23:59:59Z", number: 3 }),
        ],
        { hasNextPage: true, endCursor: "cursor-1" },
      )),
    ]);
    const provider = createProvider(http);

    const pages = await collect(provider.fetchPullRequestUpdates({
      repository,
      mode: "incremental",
      watermarkUpdatedAt: "2024-05-10T00:02:00Z",
      lookbackDays: 7,
    }));

    expect(pages).toHaveLength(1);
    expect(pages[0]?.items.map((item) => item.number)).toEqual([2, 1]);
    expect(requestBody(http, 0).variables).toEqual({
      owner: "acme",
      name: "rocket",
      cursor: null,
      states: ["OPEN", "CLOSED", "MERGED"],
    });
    expect(http.calls).toHaveLength(1);
  });

  it("includes cutoff equality and normalizes all PR timestamps to UTC", async () => {
    const http = createFakeHttp([
      httpJson(pullRequestResponse([
        pullRequestNode({
          number: 10,
          updatedAt: "2024-06-09T16:00:00+08:00",
          createdAt: "2024-06-01T08:00:00+08:00",
          closedAt: "2024-06-09T16:00:00+08:00",
          mergedAt: "2024-06-09T16:00:00+08:00",
          author: null,
        }),
      ], { hasNextPage: false, endCursor: null })),
    ]);
    const provider = createProvider(http);

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
    const http = createFakeHttp([
      httpJson(pullRequestResponse(
        [pullRequestNode({ state: "MERGED", mergedAt: null })],
        { hasNextPage: false, endCursor: null },
      )),
    ]);
    const provider = createProvider(http);

    const [page] = await collect(provider.fetchPullRequestUpdates({
      repository,
      mode: "incremental",
      watermarkUpdatedAt: "2024-06-10T00:02:00Z",
    }));

    expect(page?.items[0]).toMatchObject({ stateRaw: "MERGED", status: "merged" });
    expect(requestBody(http, 0).variables.states).toEqual([
      "OPEN",
      "CLOSED",
      "MERGED",
    ]);
  });

  it("maps issue fields, nullable authors, pagination cursors, and rate limits", async () => {
    const http = createFakeHttp([
      httpJson(issueResponse(
        [issueNode({ number: 7, author: null, updatedAt: "2024-06-10T00:00:00Z" })],
        { hasNextPage: true, endCursor: "issue-cursor" },
      )),
      httpJson(issueResponse(
        [issueNode({ number: 8, state: "CLOSED", comments: { totalCount: 3 } })],
        { hasNextPage: false, endCursor: null },
      )),
    ]);
    const provider = createProvider(http);

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
    expect(requestBody(http, 1).variables).toEqual({
      owner: "acme",
      name: "rocket",
      cursor: "issue-cursor",
      states: ["OPEN", "CLOSED"],
    });
    expect(requestBody(http, 0).query).toContain("comments { totalCount }");
    expect(requestBody(http, 0).query).not.toContain("comments(first");
  });

  it("keeps the 30-day initial Issue boundary across all states and stops before the next page", async () => {
    const http = createFakeHttp([
      httpJson(issueResponse(
        [
          issueNode({
            id: "I_OPEN",
            number: 91,
            state: "OPEN",
            updatedAt: "2024-05-11T00:00:00Z",
            closedAt: null,
          }),
          issueNode({
            id: "I_BOUNDARY",
            number: 90,
            state: "CLOSED",
            updatedAt: "2024-05-11T00:00:00Z",
            closedAt: "2024-05-11T00:00:00Z",
          }),
          issueNode({
            id: "I_OLD",
            number: 89,
            state: "CLOSED",
            updatedAt: "2024-05-10T23:59:59Z",
            closedAt: "2024-05-10T23:59:59Z",
          }),
        ],
        { hasNextPage: true, endCursor: "initial-issue-next" },
      )),
    ]);
    const provider = createProvider(http);

    const pages = await collect(provider.fetchIssueUpdates({
      repository,
      mode: "bootstrap",
      syncStartedAt: "2024-06-10T00:00:00Z",
    }));

    expect(pages).toHaveLength(1);
    expect(pages[0]?.items).toHaveLength(2);
    expect(pages[0]?.items.map((item) => item.status)).toEqual(["open", "closed"]);
    expect(pages[0]?.items[1]).toMatchObject({
      number: 90,
      state: "CLOSED",
      status: "closed",
      updatedAt: "2024-05-11T00:00:00.000Z",
    });
    expect(requestBody(http, 0).variables.states).toEqual(["OPEN", "CLOSED"]);
    expect(http.calls).toHaveLength(1);
  });

  it.each([
    ["invalid JSON", "not-json", "response body is not valid JSON"],
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
    const http = createFakeHttp([httpJson(response)]);
    const provider = createProvider(http);

    await expect(
      collect(provider.fetchPullRequestUpdates({
        repository,
        mode: "bootstrap",
        syncStartedAt,
      })),
    ).rejects.toThrow(expected);
  });

  it("rejects GraphQL partial data even when data is present", async () => {
    const http = createFakeHttp([
      httpJson({
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
    const provider = createProvider(http);

    await expect(
      collect(provider.fetchPullRequestUpdates({
        repository,
        mode: "bootstrap",
        syncStartedAt,
      })),
    ).rejects.toBeInstanceOf(GitHubGraphQLError);
  });

  it("rejects a repeated pagination cursor instead of fetching duplicate pages forever", async () => {
    const http = createFakeHttp([
      httpJson(pullRequestResponse(
        [pullRequestNode({ number: 1 })],
        { hasNextPage: true, endCursor: "same-cursor" },
      )),
      httpJson(pullRequestResponse(
        [pullRequestNode({ number: 2 })],
        { hasNextPage: true, endCursor: "same-cursor" },
      )),
    ]);
    const provider = createProvider(http);

    await expect(
      collect(provider.fetchPullRequestUpdates({
        repository,
        mode: "incremental",
        watermarkUpdatedAt: syncStartedAt,
      })),
    ).rejects.toThrow("endCursor repeated");
    expect(http.calls).toHaveLength(2);
  });

  it("surfaces HTTP failures with an explicit diagnostic", async () => {
    const http = createFakeHttp([
      httpJson({ message: "Not Found" }, 404),
    ]);
    const provider = createProvider(http);

    await expect(
      collect(provider.fetchPullRequestUpdates({
        repository,
        mode: "bootstrap",
        syncStartedAt,
      })),
    ).rejects.toMatchObject({
      name: "GitHubHttpError",
      operation: "PullRequests",
      repository: "acme/rocket",
      status: 404,
      url: graphQlUrl,
    });
  });

  it("surfaces a nonzero gh auth token exit", async () => {
    delete process.env.GITHUB_TOKEN;
    const auth = createFakeGh("", 1, "gh: authentication required");
    const http = createFakeHttp([]);
    const provider = new GhGitHubMetadataProvider({
      ghExecutable: auth.executable,
      fetch: http.fetch,
    });

    await expect(
      collect(provider.fetchPullRequestUpdates({
        repository,
        mode: "bootstrap",
        syncStartedAt,
      })),
    ).rejects.toMatchObject({
      name: "GitHubCommandError",
      command: "gh auth token",
      exitCode: 1,
      repository: "acme/rocket",
      stderr: "gh: authentication required",
    });
    expect(http.calls).toHaveLength(0);
  });

  it("requires a watermark for incremental sync", async () => {
    const http = createFakeHttp([]);
    const provider = createProvider(http);

    await expect(
      collect(provider.fetchIssueUpdates({ repository, mode: "incremental" })),
    ).rejects.toThrow("requires watermarkUpdatedAt");
  });

  it("does not accept unknown response fields", async () => {
    const response = JSON.parse(
      pullRequestResponse([pullRequestNode()], { hasNextPage: false, endCursor: null }),
    ) as { data: { repository: { pullRequests: { nodes: Array<Record<string, unknown>> } } } };
    response.data.repository.pullRequests.nodes[0]!.unexpected = "reject";
    const http = createFakeHttp([httpJson(response)]);
    const provider = createProvider(http);

    await expect(
      collect(provider.fetchPullRequestUpdates({
        repository,
        mode: "bootstrap",
        syncStartedAt,
      })),
    ).rejects.toBeInstanceOf(GitHubResponseError);
  });

  it("fetches Issue body and every comments page over REST, sorted by id", async () => {
    const commentCount = 101;
    const comments = Array.from({ length: commentCount }, (_, index) => {
      const id = index + 1;
      const createdAt = new Date(
        Date.parse("2024-06-10T00:00:00Z") + index * 60_000,
      ).toISOString();
      return restComment(id, createdAt);
    });
    const http = createFakeHttp([
      httpJson({
        number: 7,
        title: "Track comments",
        html_url: "https://github.com/acme/rocket/issues/7",
        state: "open",
        user: { login: "octocat" },
        body: "Issue **body**.",
        comments: commentCount,
        created_at: "2024-06-01T00:00:00Z",
        updated_at: "2024-06-10T00:03:04Z",
        closed_at: null,
      }),
      // First page deliberately reversed; the provider must normalize order.
      httpJson(comments.slice(0, 100).reverse()),
      httpJson(comments.slice(100)),
    ]);
    const provider = createProvider(http);

    const detail = await provider.fetchIssueDetail({
      repository,
      number: 7,
    });

    expect(detail).toMatchObject({
      number: 7,
      title: "Track comments",
      url: "https://github.com/acme/rocket/issues/7",
      state: "open",
      authorLogin: "octocat",
      commentsCount: 101,
      body: "Issue **body**.",
      createdAt: "2024-06-01T00:00:00.000Z",
      updatedAt: "2024-06-10T00:03:04.000Z",
      closedAt: null,
    });
    expect(detail.comments).toHaveLength(101);
    expect(detail.comments.map((comment) => comment.id)).toEqual(
      Array.from({ length: 101 }, (_, index) => index + 1),
    );
    expect(detail.comments[0]).toMatchObject({
      id: 1,
      authorLogin: "commenter-1",
      body: "Comment 1",
      createdAt: "2024-06-10T00:00:00.000Z",
      url: "https://github.com/acme/rocket/issues/7#issuecomment-1",
    });
    expect(http.calls).toHaveLength(3);
    expect(http.calls[0]).toMatchObject({
      url: `${apiBaseUrl}/repos/acme/rocket/issues/7`,
      method: "GET",
      headers: {
        authorization: "Bearer test-token",
        accept: "application/vnd.github+json",
      },
    });
    expect(http.calls[0]?.headers["content-type"]).toBeUndefined();
    expect(http.calls[1]?.url).toBe(
      `${apiBaseUrl}/repos/acme/rocket/issues/7/comments?per_page=100&page=1`,
    );
    expect(http.calls[2]?.url).toBe(
      `${apiBaseUrl}/repos/acme/rocket/issues/7/comments?per_page=100&page=2`,
    );
  });

  it("prefers GITHUB_TOKEN and makes direct HTTP requests without spawning gh", async () => {
    process.env.GITHUB_TOKEN = "gho_env_token";
    const auth = createFakeGh("gho_child_token");
    const http = createFakeHttp([
      httpJson(pullRequestResponse(
        [pullRequestNode({ number: 1 })],
        { hasNextPage: false, endCursor: null },
      )),
    ]);
    const provider = new GhGitHubMetadataProvider({
      ghExecutable: auth.executable,
      fetch: http.fetch,
    });

    const pages = await collect(provider.fetchPullRequestUpdates({
      repository,
      mode: "bootstrap",
      syncStartedAt,
    }));

    expect(pages).toHaveLength(1);
    expect(http.calls).toHaveLength(1);
    expect(http.calls[0]?.headers.authorization).toBe("Bearer gho_env_token");
    expect(auth.calls).toHaveLength(0);
  });

  it("invokes gh auth token once and uses direct HTTP for every page afterwards", async () => {
    delete process.env.GITHUB_TOKEN;
    const auth = createFakeGh("gho_child_token\n");
    const http = createFakeHttp([
      httpJson(issueResponse(
        [issueNode({ number: 7 })],
        { hasNextPage: true, endCursor: "issue-cursor" },
      )),
      httpJson(issueResponse(
        [issueNode({ number: 8, state: "CLOSED" })],
        { hasNextPage: false, endCursor: null },
      )),
    ]);
    const provider = new GhGitHubMetadataProvider({
      ghExecutable: auth.executable,
      fetch: http.fetch,
    });

    const pages = await collect(provider.fetchIssueUpdates({
      repository,
      mode: "incremental",
      watermarkUpdatedAt: "2024-06-10T00:02:00Z",
    }));

    expect(pages).toHaveLength(2);
    expect(http.calls).toHaveLength(2);
    expect(auth.calls).toEqual([["auth", "token"]]);
    expect(http.calls[0]?.headers.authorization).toBe("Bearer gho_child_token");
    expect(http.calls[1]?.headers.authorization).toBe("Bearer gho_child_token");
  });

  it("calls an injected token resolver once across a multi-page operation", async () => {
    let resolveCount = 0;
    const http = createFakeHttp([
      httpJson(issueResponse(
        [issueNode({ number: 7 })],
        { hasNextPage: true, endCursor: "issue-cursor" },
      )),
      httpJson(issueResponse([], { hasNextPage: false, endCursor: null })),
    ]);
    const provider = new GhGitHubMetadataProvider({
      fetch: http.fetch,
      tokenResolver: async () => {
        resolveCount += 1;
        return "injected-token";
      },
    });

    await collect(provider.fetchIssueUpdates({
      repository,
      mode: "incremental",
      watermarkUpdatedAt: "2024-06-10T00:02:00Z",
    }));

    expect(resolveCount).toBe(1);
    expect(http.calls).toHaveLength(2);
    expect(http.calls[0]?.headers.authorization).toBe("Bearer injected-token");
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

function restComment(id: number, createdAt: string): Record<string, unknown> {
  return {
    id,
    user: { login: `commenter-${id}` },
    body: `Comment ${id}`,
    created_at: createdAt,
    updated_at: createdAt,
    html_url: `https://github.com/acme/rocket/issues/7#issuecomment-${id}`,
  };
}

function httpJson(body: unknown, status = 200): Response {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return new Response(text, {
    status,
    headers: { "content-type": "application/json" },
  });
}

interface RecordedHttpRequest {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body: string | null;
}

interface FakeHttp {
  readonly fetch: GitHubFetch;
  readonly calls: RecordedHttpRequest[];
}

function createFakeHttp(responses: readonly Response[]): FakeHttp {
  const calls: RecordedHttpRequest[] = [];
  const fetchImplementation: GitHubFetch = async (input, init) => {
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(
      (init?.headers ?? {}) as Record<string, string>,
    )) {
      headers[key.toLowerCase()] = String(value);
    }
    calls.push({
      url: String(input),
      method: init?.method ?? "GET",
      headers,
      body: typeof init?.body === "string" ? init.body : null,
    });
    const response = responses[calls.length - 1];
    if (response === undefined) {
      throw new Error(
        `unexpected fake HTTP request ${calls.length}: ${calls[calls.length - 1]?.method} ${calls[calls.length - 1]?.url}`,
      );
    }
    return response;
  };
  return { fetch: fetchImplementation, calls };
}

function createProvider(
  http: FakeHttp,
  extra: Partial<GhGitHubMetadataProviderOptions> = {},
): GhGitHubMetadataProvider {
  return new GhGitHubMetadataProvider({
    fetch: http.fetch,
    tokenResolver: async () => "test-token",
    ...extra,
  });
}

function requestBody(
  http: FakeHttp,
  index: number,
): { query: string; variables: Record<string, unknown> } {
  const call = http.calls[index];
  if (call?.body === null) {
    throw new Error(`HTTP call ${index} has no body`);
  }
  return JSON.parse(call?.body ?? "{}") as {
    query: string;
    variables: Record<string, unknown>;
  };
}

interface FakeGh {
  readonly directory: string;
  readonly executable: string;
  readonly calls: string[][];
}

function readGhCalls(directory: string): string[][] {
  const calls: string[][] = [];
  for (let index = 0; ; index += 1) {
    const callPath = join(directory, `call-${index}.json`);
    let raw: string;
    try {
      raw = readFileSync(callPath, "utf8");
    } catch {
      break;
    }
    const call = JSON.parse(raw) as { argv: string[] };
    calls.push(call.argv);
  }
  return calls;
}

function createFakeGh(
  output = "",
  exitCode = 0,
  stderr = "",
): FakeGh {
  const directory = mkdtempSync(join(tmpdir(), "loongboard-gh-"));
  temporaryDirectories.push(directory);
  const executable = join(directory, "gh-fake.cjs");
  const script = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const directory = ${JSON.stringify(directory)};
const countPath = path.join(directory, "count");
const count = Number(fs.existsSync(countPath) ? fs.readFileSync(countPath, "utf8") : "0");
fs.writeFileSync(countPath, String(count + 1));
const argv = process.argv.slice(2);
fs.writeFileSync(path.join(directory, "call-" + count + ".json"), JSON.stringify({ argv }));
if (argv[0] === "api") {
  process.stderr.write("unexpected gh api child process");
  process.exit(97);
}
if (${exitCode} !== 0) {
  process.stderr.write(${JSON.stringify(stderr)});
  process.exit(${exitCode});
}
process.stdout.write(${JSON.stringify(output)});
`;
  writeFileSync(executable, script);
  chmodSync(executable, 0o755);

  return {
    directory,
    executable,
    get calls() {
      return readGhCalls(directory);
    },
  };
}

async function collect<T>(iterable: AsyncIterable<{ items: readonly T[] }>): Promise<Array<{ items: readonly T[] }>> {
  const pages: Array<{ items: readonly T[] }> = [];
  for await (const page of iterable) {
    pages.push(page);
  }
  return pages;
}
